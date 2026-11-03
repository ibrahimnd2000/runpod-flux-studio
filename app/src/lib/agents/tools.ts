import "server-only";

import { z } from "zod";

import { config, videoModels } from "../config";
import { LimitError } from "../limits";
import { listMedia, readMedia } from "../media";
import { endpointHealth } from "../runpod";
import { animateImage, generateImages, MEASURED, videoAvailable, type GpuCtx } from "./gpu";
import type { ToolCall, ToolReply, ToolSpec } from "./providers";
import { addSpend, totalUsd, type RunState } from "./runs";

// The tools an agent can call. Each one is a thin wrapper over the same code the
// Studio uses, plus a budget check: a call that would push the run past its
// dollar, image or video budget is refused with a tool error the model can read
// and adapt to (fewer images, draft quality, reuse from the library...).

const QUALITY = {
  draft: { width: 768, height: 768, steps: 16 },
  final: { width: 1024, height: 1024, steps: 28 },
} as const;
const ASPECT = { square: [1, 1], landscape: [4 / 3, 3 / 4], portrait: [3 / 4, 4 / 3] } as const;

function imageSize(quality: keyof typeof QUALITY, aspect: keyof typeof ASPECT) {
  const q = QUALITY[quality];
  const [w, h] = ASPECT[aspect];
  const snap = (v: number) => Math.min(Math.round(v / 16) * 16, config.maxSide);
  return { width: snap(q.width * w), height: snap(q.height * h), steps: Math.min(q.steps, config.maxSteps) };
}

/** Measured warm cost of one image at this size, scaled by pixels x steps. */
export const imageCost = (s: { width: number; height: number; steps: number }) =>
  MEASURED.imageUsd * ((s.width * s.height) / 1024 ** 2) * (s.steps / 28);

const schemas = {
  generate_images: z.object({
    prompts: z.array(z.string().min(3).max(800)).min(1).max(4).describe("1-4 FLUX prompts; each becomes one image, all rendered in parallel."),
    quality: z.enum(["draft", "final"]).default("final").describe("draft: 768², 16 steps, ~40% of the cost. final: 1024², 28 steps."),
    aspect: z.enum(["square", "landscape", "portrait"]).default("square"),
  }),
  animate_image: z.object({
    media_id: z.string().describe("Library id of an image to animate."),
    motion: z.string().min(3).max(500).describe("Camera and subject motion, e.g. 'slow push-in, steam rising from the cup'."),
    seconds: z.union([z.literal(2), z.literal(3), z.literal(5)]).default(2),
  }),
  view_image: z.object({ media_id: z.string() }),
  search_library: z.object({
    query: z.string().max(200).describe("Words to match against prompts of existing images; empty for the newest."),
    limit: z.number().int().min(1).max(8).default(5),
  }),
  check_endpoints: z.object({}),
  estimate_cost: z.object({
    images: z.number().int().min(0).max(20).default(0),
    quality: z.enum(["draft", "final"]).default("final"),
    video_seconds: z.number().int().min(0).max(30).default(0),
  }),
  finish: z.object({
    summary: z.string().max(2000).describe("What you made and why, for the person who wrote the brief."),
    media_ids: z.array(z.string()).max(8).describe("The library ids that answer the brief, best first."),
  }),
};

type ToolName = keyof typeof schemas;

const DESCRIPTIONS: Record<ToolName, string> = {
  generate_images:
    "Render images with FLUX.1-dev on the Runpod Serverless GPU endpoint. Each prompt is one GPU job; all run in parallel. " +
    `About ${MEASURED.imageWarmS.toFixed(0)} s and $${MEASURED.imageUsd} per final-quality image on a warm worker; a cold start adds 30-90+ s. ` +
    "Returns library ids. Write prompts as concrete visual descriptions (subject, setting, light, composition, style).",
  animate_image:
    "Turn one library image into a short silent video clip (Wan 2.2 image-to-video on a separate GPU endpoint). " +
    `About $${MEASURED.videoUsdPerS} and ${MEASURED.videoExecSPerS.toFixed(0)} s of GPU time per second of video, plus any cold start.`,
  view_image: "Look at a library image to judge it before choosing or refining. Free.",
  search_library: "Find existing images in the media library by prompt text. Reusing one costs nothing. Free.",
  check_endpoints: "Current state of the GPU endpoints: warm/idle workers and queue depth, to anticipate cold starts. Free.",
  estimate_cost: "Estimate dollars and time for a plan before spending. Free.",
  finish: "Deliver the result and end the run: the media ids that answer the brief and a short summary. Call this exactly once, last.",
};

function jsonSchema(s: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(s, { io: "input" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

/** Tools offered to this run: vision tools only for models that can see, video only when it's set up. */
export function toolSpecs(opts: { vision: boolean; dryRun: boolean }): ToolSpec[] {
  return (Object.keys(schemas) as ToolName[])
    .filter((n) => (n === "view_image" ? opts.vision : n === "animate_image" ? opts.dryRun || videoAvailable() : true))
    .map((n) => ({ name: n, description: DESCRIPTIONS[n], schema: jsonSchema(schemas[n]) }));
}

export const toolCatalog = () =>
  (Object.keys(schemas) as ToolName[]).map((n) => ({ name: n, description: DESCRIPTIONS[n], vision: n === "view_image" }));

export interface ToolOutcome {
  reply: ToolReply;
  summary: string;
  mediaIds?: string[];
  costUsd?: number;
  finish?: { summary: string; mediaIds: string[] };
}

function budgetLeft(run: RunState) {
  const { budget, spend } = run.view;
  return {
    usd: +(budget.maxUsd - totalUsd(spend)).toFixed(4),
    images: budget.maxImages - spend.images,
    videos: budget.maxVideos - spend.videos,
  };
}

const ok = (call: ToolCall, run: RunState, data: Record<string, unknown>, summary: string, extra: Partial<ToolOutcome> = {}): ToolOutcome => ({
  reply: { id: call.id, name: call.name, content: JSON.stringify({ ...data, budget_left: budgetLeft(run) }) },
  summary,
  ...extra,
});

const fail = (call: ToolCall, run: RunState, error: string): ToolOutcome => ({
  reply: { id: call.id, name: call.name, content: JSON.stringify({ error, budget_left: budgetLeft(run) }), isError: true },
  summary: error,
});

/** Runs one tool call. Never throws: every failure becomes a tool error the model sees. */
export async function executeTool(call: ToolCall, run: RunState, gpu: GpuCtx, vision: boolean): Promise<ToolOutcome> {
  const schema = schemas[call.name as ToolName];
  const allowed = toolSpecs({ vision, dryRun: gpu.dryRun }).some((t) => t.name === call.name);
  if (!schema || !allowed) return fail(call, run, `Unknown tool ${call.name}.`);
  const parsed = schema.safeParse(call.args);
  if (!parsed.success) return fail(call, run, `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const args = parsed.data as never;
  try {
    return await TOOLS[call.name as ToolName](call, run, gpu, args);
  } catch (e) {
    if (e instanceof LimitError) return fail(call, run, e.message);
    console.error(`tool ${call.name} failed`, e);
    return fail(call, run, "The tool failed unexpectedly; try again or change the plan.");
  }
}

type Impl<N extends ToolName> = (call: ToolCall, run: RunState, gpu: GpuCtx, args: z.output<(typeof schemas)[N]>) => Promise<ToolOutcome>;

const TOOLS: { [N in ToolName]: Impl<N> } = {
  async generate_images(call, run, gpu, { prompts, quality, aspect }) {
    const size = imageSize(quality, aspect);
    const est = imageCost(size) * prompts.length;
    const left = budgetLeft(run);
    if (prompts.length > left.images)
      return fail(call, run, `Image budget: ${left.images} image(s) left, you asked for ${prompts.length}.`);
    if (est > left.usd + 1e-9)
      return fail(call, run, `Budget: this would cost ~$${est.toFixed(4)}, only $${left.usd.toFixed(4)} left. Try fewer images or draft quality.`);

    const results = await generateImages(gpu, prompts, size);
    const done = results.filter((r) => r.mediaId);
    const cost = results.reduce((a, r) => a + r.costUsd, 0);
    addSpend(run, { gpuUsd: cost, images: done.length });
    const images = results.map((r) =>
      r.mediaId
        ? { media_id: r.mediaId, prompt: r.prompt, seconds: r.executionMs ? +(r.executionMs / 1000).toFixed(1) : undefined, queue_s: r.delayMs ? +(r.delayMs / 1000).toFixed(1) : undefined, gpu: r.gpu, cost_usd: +r.costUsd.toFixed(4) }
        : { prompt: r.prompt, error: r.error },
    );
    return ok(
      call,
      run,
      { images, size: `${size.width}x${size.height}`, steps: size.steps },
      `${done.length}/${results.length} image(s), $${cost.toFixed(4)}`,
      { mediaIds: done.map((r) => r.mediaId!), costUsd: cost },
    );
  },

  async animate_image(call, run, gpu, { media_id, motion, seconds }) {
    const left = budgetLeft(run);
    const est = MEASURED.videoUsdPerS * seconds;
    if (left.videos < 1) return fail(call, run, "Video budget: no clips left for this run.");
    if (est > left.usd + 1e-9) return fail(call, run, `Budget: a ${seconds} s clip costs ~$${est.toFixed(3)}, only $${left.usd.toFixed(4)} left.`);
    const r = await animateImage(gpu, media_id, motion, seconds);
    addSpend(run, { gpuUsd: r.costUsd, videos: r.mediaId ? 1 : 0 });
    if (!r.mediaId) return fail(call, run, r.error ?? "The video job failed.");
    return ok(
      call,
      run,
      { media_id: r.mediaId, model: r.model, seconds_of_video: seconds, gpu_seconds: r.executionMs ? +(r.executionMs / 1000).toFixed(1) : undefined, cost_usd: +r.costUsd.toFixed(4) },
      `${seconds} s clip, $${r.costUsd.toFixed(4)}`,
      { mediaIds: [r.mediaId], costUsd: r.costUsd },
    );
  },

  async view_image(call, run, _gpu, { media_id }) {
    const file = readMedia(media_id);
    if (!file || file.kind !== "image") return fail(call, run, `No library image with id ${media_id}.`);
    const reply: ToolReply = {
      id: call.id,
      name: call.name,
      content: JSON.stringify({ media_id, budget_left: budgetLeft(run) }),
      images: [{ mime: "image/jpeg", data: file.bytes.toString("base64") }],
    };
    return { reply, summary: "looked at the image", mediaIds: [media_id] };
  },

  async search_library(call, run, _gpu, { query, limit }) {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const scored = listMedia()
      .filter((m) => (m.kind ?? "image") === "image")
      .map((m) => ({ m, score: words.filter((w) => m.prompt.toLowerCase().includes(w)).length }))
      .filter((x) => !words.length || x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt)
      .slice(0, limit);
    const items = scored.map(({ m }) => ({ media_id: m.id, prompt: m.prompt, size: `${m.width}x${m.height}` }));
    return ok(call, run, { items }, `${items.length} match(es)`, { mediaIds: items.map((i) => i.media_id) });
  },

  async check_endpoints(call, run, gpu) {
    const describe = async (id: string) => {
      if (!id || !config.apiKey) return { configured: false };
      try {
        const h = await endpointHealth(id);
        const w = h.workers ?? {};
        return {
          configured: true,
          workers_running: w.running ?? 0,
          workers_idle: w.idle ?? 0,
          workers_starting: w.initializing ?? 0,
          jobs_queued: h.jobs?.inQueue ?? 0,
          jobs_running: h.jobs?.inProgress ?? 0,
          expect: (w.idle ?? 0) + (w.running ?? 0) > 0 ? "warm: jobs start within seconds" : "cold: the first job waits for a worker (30-90+ s)",
        };
      } catch {
        return { configured: true, error: "status unavailable" };
      }
    };
    const vm = videoModels()[0];
    const data = {
      dry_run: gpu.dryRun || undefined,
      image_endpoint: await describe(config.endpointId),
      video_endpoint: vm ? { model: vm, ...(await describe(config.videoEndpoints[vm])) } : { configured: false },
    };
    const warm = (data.image_endpoint as { expect?: string }).expect?.split(":")[0] ?? "n/a";
    return ok(call, run, data, `image endpoint ${warm}`);
  },

  async estimate_cost(call, run, _gpu, { images, quality, video_seconds }) {
    const per = imageCost(imageSize(quality, "square"));
    const usd = images * per + video_seconds * MEASURED.videoUsdPerS;
    const parallel = Math.max(1, Math.min(images, 2)); // image endpoint runs up to 2 workers
    const warmS = Math.ceil(images / parallel) * MEASURED.imageWarmS * (quality === "draft" ? 0.45 : 1) + video_seconds * MEASURED.videoExecSPerS;
    return ok(
      call,
      run,
      { usd: +usd.toFixed(4), seconds_if_warm: Math.round(warmS), seconds_if_cold: Math.round(warmS + MEASURED.imageColdS), per_image_usd: +per.toFixed(4) },
      `~$${usd.toFixed(4)}`,
    );
  },

  async finish(call, run, _gpu, { summary, media_ids }) {
    return ok(call, run, { ok: true }, "delivered", { finish: { summary, mediaIds: media_ids }, mediaIds: media_ids });
  },
};
