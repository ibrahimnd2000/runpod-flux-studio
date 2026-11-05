import "server-only";

import type { ModelOption, PipelineSpec, PipelineStep, StepOutput, StepType } from "../agentTypes";
import { LimitError } from "../limits";
import { readMedia } from "../media";
import { animateImage, generateImages, MEASURED, type GpuCtx } from "./gpu";
import { complete } from "./providers";
import { addSpend, emit, finishRun, reserveSpend, setPhase, totalUsd, type RunState } from "./runs";
import { imageCost } from "./tools";

// Deterministic workflows: a list of steps whose dependencies form a DAG. A step
// starts as soon as everything it reads ({{steps.x}} or `from`) is done, so
// independent branches run in parallel, and an `images` step fans out into one
// GPU job per prompt. Unlike an agent, the shape of the work is fixed in advance:
// predictable cost, no model deciding what to do next.

export const TEMPLATES: Omit<PipelineSpec, "llm">[] = [
  {
    id: "launch-kit",
    name: "Product launch kit",
    description: "An LLM writes 4 shot ideas, FLUX renders them in parallel, the best one is picked and animated while the copy is written.",
    inputs: [
      { key: "product", label: "Product", default: "A matte-black insulated coffee tumbler with a copper lid" },
      { key: "vibe", label: "Audience & mood", default: "busy commuters, warm early-morning light, calm and premium" },
    ],
    steps: [
      {
        id: "ideas",
        type: "llm",
        title: "Write shot ideas",
        list: true,
        count: 4,
        prompt:
          "Write distinct FLUX prompts for product photos of: {{input.product}}. Audience and mood: {{input.vibe}}. Vary the setting, camera angle and lighting. Each prompt is one concrete visual description.",
      },
      { id: "shots", type: "images", title: "Render shots", from: "ideas", prompt: "{{item}}" },
      { id: "hero", type: "pick", title: "Pick the hero shot", from: "shots", prompt: "Which shot works best as the hero image of a launch ad for {{input.product}}, for {{input.vibe}}?" },
      { id: "motion", type: "animate", title: "Animate the hero", from: "hero", prompt: "slow cinematic push-in, soft light shifting across the product", seconds: 2 },
      {
        id: "copy",
        type: "llm",
        title: "Write launch copy",
        prompt:
          "Write launch copy for {{input.product}} (audience and mood: {{input.vibe}}): a headline under 8 words, a two-sentence body and a call to action. The hero image shows: {{steps.hero.prompt}}",
      },
    ],
  },
  {
    id: "style-explorer",
    name: "Style explorer",
    description: "The subject as written and three restyled versions, rendered on two parallel branches.",
    inputs: [{ key: "subject", label: "Subject", default: "a lighthouse on a cliff during a storm" }],
    steps: [
      {
        id: "styles",
        type: "llm",
        title: "Restyle the subject",
        list: true,
        count: 3,
        prompt: "Rewrite this subject as FLUX prompts in clearly different visual styles (for example film photo, ink illustration, 3D render): {{input.subject}}",
      },
      { id: "literal", type: "image", title: "Render as written", prompt: "{{input.subject}}" },
      { id: "styled", type: "images", title: "Render the styles", from: "styles", prompt: "{{item}}" },
    ],
  },
  {
    id: "storyboard",
    name: "Storyboard",
    description: "A story becomes 3 consistent shots and captions in parallel, and the opening shot is animated.",
    inputs: [{ key: "story", label: "Story idea", default: "a small robot finds a flower growing in a scrapyard" }],
    steps: [
      {
        id: "beats",
        type: "llm",
        title: "Break into shots",
        list: true,
        count: 3,
        prompt:
          "Turn this story into consecutive storyboard shots, each a FLUX prompt. Repeat the same detailed description of the main character in every prompt so the shots stay consistent. Story: {{input.story}}",
      },
      { id: "frames", type: "images", title: "Render frames", from: "beats", prompt: "{{item}}, cinematic storyboard frame", width: 1024, height: 768 },
      { id: "captions", type: "llm", title: "Write captions", prompt: "Write a one-line caption for each of these storyboard shots, numbered:\n{{steps.beats}}" },
      { id: "opener", type: "animate", title: "Animate the opening", from: "frames", prompt: "gentle camera drift, subtle ambient motion", seconds: 2 },
    ],
  },
];

const STEP_TYPES: StepType[] = ["llm", "image", "images", "pick", "animate"];
const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const MAX_STEPS = 8;

/** Steps a step reads from: `from` plus every {{steps.x}} in its prompt. */
export function dependencies(step: PipelineStep): string[] {
  const refs = [...(step.prompt ?? "").matchAll(/\{\{\s*steps\.([a-z0-9_]+)/g)].map((m) => m[1]);
  return [...new Set([...(step.from ? [step.from] : []), ...refs])];
}

/** Validates a (possibly user-edited) spec. Steps may only read earlier steps, so the graph can't have cycles. */
export function validateSpec(spec: PipelineSpec): PipelineSpec {
  if (!Array.isArray(spec.steps) || !spec.steps.length) throw new LimitError("A pipeline needs at least one step.", 400);
  if (spec.steps.length > MAX_STEPS) throw new LimitError(`At most ${MAX_STEPS} steps.`, 400);
  const seen = new Map<string, StepType>();
  const steps = spec.steps.map((s): PipelineStep => {
    if (!ID_RE.test(s.id ?? "")) throw new LimitError(`Step id "${s.id}" must be lowercase letters, digits or _.`, 400);
    if (seen.has(s.id)) throw new LimitError(`Duplicate step id "${s.id}".`, 400);
    if (!STEP_TYPES.includes(s.type)) throw new LimitError(`Unknown step type "${s.type}".`, 400);
    const step: PipelineStep = {
      id: s.id,
      type: s.type,
      title: String(s.title ?? s.id).slice(0, 60),
      prompt: String(s.prompt ?? "").slice(0, 2000),
      list: s.type === "llm" ? !!s.list : undefined,
      count: s.type === "llm" && s.list ? Math.min(Math.max(Math.round(Number(s.count) || 3), 1), 4) : undefined,
      from: s.from || undefined,
      width: s.width ? Number(s.width) : undefined,
      height: s.height ? Number(s.height) : undefined,
      seconds: s.type === "animate" ? ([2, 3, 5].includes(Number(s.seconds)) ? (Number(s.seconds) as 2 | 3 | 5) : 2) : undefined,
    };
    for (const d of dependencies(step))
      if (!seen.has(d)) throw new LimitError(`Step "${s.id}" reads "${d}", which must be an earlier step.`, 400);
    const needsFrom: Partial<Record<StepType, StepType[]>> = { images: ["llm"], pick: ["images"], animate: ["image", "images", "pick"] };
    const want = needsFrom[step.type];
    if (want && (!step.from || !want.includes(seen.get(step.from)!)))
      throw new LimitError(`Step "${s.id}" (${step.type}) needs "from" pointing at a ${want.join(" / ")} step.`, 400);
    if (step.type === "images" && !spec.steps.find((x) => x.id === step.from)?.list)
      throw new LimitError(`Step "${s.id}" fans out over "${step.from}", which must return a list.`, 400);
    if ((step.type === "llm" || step.type === "image") && !step.prompt?.trim()) throw new LimitError(`Step "${s.id}" needs a prompt.`, 400);
    seen.set(step.id, step.type);
    return step;
  });
  return { ...spec, name: String(spec.name ?? "Custom pipeline").slice(0, 80), steps };
}

export function render(template: string, inputs: Record<string, string>, outputs: Map<string, StepOutput>, item?: string) {
  return template
    .replace(/\{\{\s*item\s*\}\}/g, item ?? "")
    .replace(/\{\{\s*input\.([a-z0-9_]+)\s*\}\}/gi, (_, k) => inputs[k] ?? "")
    .replace(/\{\{\s*steps\.([a-z0-9_]+)(?:\.([a-z]+))?\s*\}\}/g, (_, id, field) => {
      const o = outputs.get(id);
      if (!o) return "";
      if (field === "prompt") return o.prompts?.[0] ?? "";
      if (field === "reason") return o.reason ?? "";
      if (o.list) return o.list.map((x, i) => `${i + 1}. ${x}`).join("\n");
      if (o.text) return o.text;
      return (o.prompts ?? []).map((x, i) => `${i + 1}. ${x}`).join("\n");
    })
    .trim();
}

/** First JSON array/object in a model reply (models sometimes wrap JSON in prose or fences). */
export function extractJson(text: string): unknown {
  const m = /[[{][\s\S]*[\]}]/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const LLM_SYSTEM = "You are one step in an automated creative pipeline. Do exactly what the step asks. No preamble, no follow-up questions.";

interface Ctx {
  run: RunState;
  gpu: GpuCtx;
  llm: ModelOption;
  inputs: Record<string, string>;
  outputs: Map<string, StepOutput>;
}

async function llmCall(ctx: Ctx, text: string, images?: { mime: "image/jpeg"; data: string }[]) {
  const t = await complete(ctx.llm, LLM_SYSTEM, { text, images }, undefined, (phase) => setPhase(ctx.run, phase));
  addSpend(ctx.run, {
    llmUsd: t.costUsd,
    llmEstimatedUsd: t.estimated ? t.costUsd : 0,
    turns: 1,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
  });
  if (ctx.llm.provider !== "scripted")
    emit(ctx.run, { type: "llm", model: t.model, inputTokens: t.inputTokens, outputTokens: t.outputTokens, ms: t.ms, costUsd: t.costUsd, estimated: t.estimated });
  if (t.stop === "refusal") throw new LimitError("The model declined this step.", 400);
  return t.texts.join("\n").trim();
}

/** Checks the run's budget and reserves the step's estimated spend (see reserveSpend); returns settle(). */
function checkBudget(ctx: Ctx, usd: number, images = 0, videos = 0) {
  const { budget, spend } = ctx.run.view;
  if (spend.images + images > budget.maxImages) throw new LimitError(`Image budget: ${budget.maxImages - spend.images} left, this step needs ${images}.`, 400);
  if (spend.videos + videos > budget.maxVideos) throw new LimitError("Video budget: no clips left for this run.", 400);
  if (totalUsd(spend) + usd > budget.maxUsd) throw new LimitError(`Budget: this step costs ~$${usd.toFixed(3)}, $${(budget.maxUsd - totalUsd(spend)).toFixed(3)} left.`, 400);
  return reserveSpend(ctx.run, { gpuUsd: usd, images, videos });
}

const firstImage = (o?: StepOutput) => ({ id: o?.mediaIds?.[0], prompt: o?.prompts?.[0] ?? "" });

async function runStep(step: PipelineStep, ctx: Ctx): Promise<{ out: StepOutput; summary: string; costUsd?: number }> {
  const r = (t: string, item?: string) => render(t, ctx.inputs, ctx.outputs, item);
  const size = { width: step.width ?? 1024, height: step.height ?? 1024, steps: 28 };

  switch (step.type) {
    case "llm": {
      if (!step.list) {
        const text = await llmCall(ctx, r(step.prompt!));
        return { out: { text }, summary: text };
      }
      const ask = `${r(step.prompt!)}\n\nReturn only a JSON array of exactly ${step.count} strings.`;
      let list: string[] = [];
      for (let attempt = 0; attempt < 2 && list.length === 0; attempt++) {
        const parsed = extractJson(await llmCall(ctx, ask));
        if (Array.isArray(parsed)) list = parsed.map(String).map((s) => s.trim()).filter(Boolean).slice(0, step.count);
      }
      if (!list.length) throw new LimitError("The model didn't return a JSON list.", 502);
      return { out: { list }, summary: list.map((x, i) => `${i + 1}. ${x}`).join("\n") };
    }
    case "image":
    case "images": {
      const prompts = step.type === "image" ? [r(step.prompt!)] : (ctx.outputs.get(step.from!)?.list ?? []).map((item) => r(step.prompt || "{{item}}", item));
      const settle = checkBudget(ctx, imageCost(size) * prompts.length, prompts.length);
      let results: Awaited<ReturnType<typeof generateImages>>;
      try {
        results = await generateImages(ctx.gpu, prompts, size);
      } catch (e) {
        settle({});
        throw e;
      }
      const ok = results.filter((x) => x.mediaId);
      const cost = results.reduce((a, x) => a + x.costUsd, 0);
      settle({ gpuUsd: cost, images: ok.length });
      if (!ok.length) throw new LimitError(results[0]?.error ?? "No image was generated.", 502);
      return {
        out: { mediaIds: ok.map((x) => x.mediaId!), prompts: ok.map((x) => x.prompt) },
        summary: `${ok.length}/${results.length} image(s)${ok.length < results.length ? ` (${results.find((x) => x.error)?.error})` : ""}`,
        costUsd: cost,
      };
    }
    case "pick": {
      const src = ctx.outputs.get(step.from!)!;
      const ids = src.mediaIds ?? [];
      const prompts = src.prompts ?? [];
      if (ids.length <= 1) return { out: { mediaIds: ids.slice(0, 1), prompts: prompts.slice(0, 1), reason: "Only one candidate." }, summary: "only one candidate" };
      const criteria = r(step.prompt || "Which image is strongest?");
      let index = 0;
      let reason = "Scripted baseline: first candidate.";
      if (ctx.llm.provider !== "scripted") {
        const ask = ctx.llm.vision
          ? `${criteria}\nThe ${ids.length} images above are candidates 1-${ids.length}, in order. Reply with only JSON: {"index": <1-${ids.length}>, "reason": "<one sentence>"}.`
          : `${criteria}\nYou can't see the images; choose from their prompts:\n${prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}\nReply with only JSON: {"index": <1-${ids.length}>, "reason": "<one sentence>"}.`;
        const images = ctx.llm.vision
          ? ids.map((id) => readMedia(id)).filter((f) => !!f).map((f) => ({ mime: "image/jpeg" as const, data: f!.bytes.toString("base64") }))
          : undefined;
        const parsed = extractJson(await llmCall(ctx, ask, images)) as { index?: number; reason?: string } | null;
        index = Math.min(Math.max(Math.round(Number(parsed?.index) || 1), 1), ids.length) - 1;
        reason = String(parsed?.reason ?? "No reason given.").slice(0, 400) + (ctx.llm.vision ? "" : " (chosen from prompts; this model can't see images)");
      }
      return { out: { mediaIds: [ids[index]], prompts: [prompts[index]], reason }, summary: `#${index + 1}: ${reason}` };
    }
    case "animate": {
      const src = firstImage(ctx.outputs.get(step.from!));
      if (!src.id) throw new LimitError("Nothing to animate.", 400);
      const seconds = step.seconds ?? 2;
      const settle = checkBudget(ctx, MEASURED.videoUsdPerS * seconds, 0, 1);
      let v: Awaited<ReturnType<typeof animateImage>>;
      try {
        v = await animateImage(ctx.gpu, src.id, r(step.prompt || "subtle camera motion"), seconds);
      } catch (e) {
        settle({});
        throw e;
      }
      settle({ gpuUsd: v.costUsd, videos: v.mediaId ? 1 : 0 });
      if (!v.mediaId) throw new LimitError(v.error ?? "The video job failed.", 502);
      return { out: { mediaIds: [v.mediaId], prompts: [src.prompt] }, summary: `${seconds} s clip (${v.model})`, costUsd: v.costUsd };
    }
  }
}

/** Runs the pipeline to completion. Never throws; the outcome is in the run's status and trace. */
export async function runPipeline(run: RunState, spec: PipelineSpec, llm: ModelOption, inputs: Record<string, string>, gpu: GpuCtx) {
  const ctx: Ctx = { run, gpu, llm, inputs, outputs: new Map() };
  const state = new Map<string, "waiting" | "running" | "done" | "failed" | "skipped">(spec.steps.map((s) => [s.id, "waiting"]));
  for (const s of spec.steps) emit(run, { type: "step", stepId: s.id, state: "waiting" });
  emit(run, { type: "status", text: `${spec.steps.length} steps · LLM: ${llm.label}${gpu.dryRun ? " · dry run" : ""}` });

  const running = new Map<string, Promise<void>>();
  const start = (step: PipelineStep) => {
    state.set(step.id, "running");
    emit(run, { type: "step", stepId: step.id, state: "running" });
    const started = Date.now();
    const p = runStep(step, ctx)
      .then(({ out, summary, costUsd }) => {
        ctx.outputs.set(step.id, out);
        state.set(step.id, "done");
        emit(run, { type: "step", stepId: step.id, state: "done", summary: summary.slice(0, 2000), mediaIds: out.mediaIds, ms: Date.now() - started, costUsd });
      })
      .catch((e) => {
        if (!(e instanceof LimitError)) console.error(`pipeline step ${step.id} failed`, e);
        state.set(step.id, "failed");
        const msg = e instanceof Error ? e.message.slice(0, 300) : "Step failed.";
        emit(run, { type: "step", stepId: step.id, state: "failed", summary: msg, ms: Date.now() - started });
      })
      .finally(() => running.delete(step.id));
    running.set(step.id, p);
  };

  for (;;) {
    if (run.aborted) break;
    for (const step of spec.steps) {
      if (state.get(step.id) !== "waiting") continue;
      const deps = dependencies(step).map((d) => state.get(d));
      if (deps.some((d) => d === "failed" || d === "skipped")) {
        state.set(step.id, "skipped");
        emit(run, { type: "step", stepId: step.id, state: "skipped", summary: "An earlier step failed." });
      } else if (deps.every((d) => d === "done")) start(step);
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }
  await Promise.allSettled(running.values());

  // Result: the last text step, and the media of every image/video step (videos first).
  const done = spec.steps.filter((s) => state.get(s.id) === "done");
  const text = [...done].reverse().map((s) => ctx.outputs.get(s.id)?.text).find(Boolean) ?? "";
  const media = [...done].reverse().filter((s) => s.type === "animate" || s.type === "images" || s.type === "image").flatMap((s) => ctx.outputs.get(s.id)?.mediaIds ?? []);
  const failed = spec.steps.some((s) => state.get(s.id) === "failed");
  if (run.aborted) return finishRun(run, "stopped", { text, mediaIds: media });
  finishRun(run, failed ? "failed" : "done", { text, mediaIds: [...new Set(media)] }, failed ? "One or more steps failed." : undefined);
}
