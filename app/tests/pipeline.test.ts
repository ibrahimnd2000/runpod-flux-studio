import { describe, expect, it } from "vitest";

import type { PipelineSpec, PipelineStep, StepOutput } from "@/lib/agentTypes";
import { dependencies, extractJson, render, runPipeline, TEMPLATES, validateSpec } from "@/lib/agents/pipeline";
import { findModel } from "@/lib/agents/providers";
import { createRun, getRun } from "@/lib/agents/runs";
import type { GpuCtx } from "@/lib/agents/gpu";

const LLM = { provider: "scripted" as const, model: "scripted" };
const spec = (steps: PipelineStep[]): PipelineSpec => ({ id: "t", name: "Test", description: "", inputs: [], steps, llm: LLM });
const dry: GpuCtx = { code: "test-code", ip: "127.0.0.1", dryRun: true, aborted: () => false };
const budget = { maxUsd: 1, maxImages: 8, maxVideos: 1, maxTurns: 8 };

describe("dependencies", () => {
  it("collects `from` and every {{steps.x}} reference, once", () => {
    const s: PipelineStep = { id: "c", type: "llm", title: "", from: "a", prompt: "{{steps.a}} and {{ steps.b.prompt }} and {{steps.a.reason}}" };
    expect(dependencies(s).sort()).toEqual(["a", "b"]);
  });
});

describe("validateSpec", () => {
  it("accepts every built-in template", () => {
    for (const t of TEMPLATES) expect(() => validateSpec({ ...t, llm: LLM })).not.toThrow();
  });

  it("rejects empty, oversized and malformed pipelines", () => {
    expect(() => validateSpec(spec([]))).toThrow(/at least one/);
    const many = Array.from({ length: 9 }, (_, i): PipelineStep => ({ id: `s${i}`, type: "image", title: "", prompt: "x" }));
    expect(() => validateSpec(spec(many))).toThrow(/At most 8/);
    expect(() => validateSpec(spec([{ id: "Bad Id", type: "image", title: "", prompt: "x" }]))).toThrow(/lowercase/);
    expect(() => validateSpec(spec([{ id: "a", type: "nope" as never, title: "", prompt: "x" }]))).toThrow(/Unknown step type/);
  });

  it("rejects duplicate ids", () => {
    const s = { id: "a", type: "image" as const, title: "", prompt: "x" };
    expect(() => validateSpec(spec([s, s]))).toThrow(/Duplicate/);
  });

  it("only lets a step read earlier steps, so the graph has no cycles", () => {
    expect(() =>
      validateSpec(
        spec([
          { id: "a", type: "llm", title: "", prompt: "{{steps.b}}" },
          { id: "b", type: "llm", title: "", prompt: "hi" },
        ]),
      ),
    ).toThrow(/earlier step/);
  });

  it("checks that `from` points at the right kind of step", () => {
    expect(() => validateSpec(spec([{ id: "a", type: "pick", title: "" }]))).toThrow(/needs "from"/);
    expect(() =>
      validateSpec(
        spec([
          { id: "a", type: "image", title: "", prompt: "x" },
          { id: "b", type: "pick", title: "", from: "a" },
        ]),
      ),
    ).toThrow(/images/);
  });

  it("requires a fan-out source to return a list", () => {
    expect(() =>
      validateSpec(
        spec([
          { id: "a", type: "llm", title: "", prompt: "x" },
          { id: "b", type: "images", title: "", from: "a" },
        ]),
      ),
    ).toThrow(/must return a list/);
  });

  it("clamps list counts and clip lengths", () => {
    const out = validateSpec(
      spec([
        { id: "a", type: "llm", title: "", prompt: "x", list: true, count: 99 },
        { id: "b", type: "images", title: "", from: "a" },
        { id: "c", type: "animate", title: "", from: "b", seconds: 7 as never },
      ]),
    );
    expect(out.steps[0].count).toBe(4);
    expect(out.steps[2].seconds).toBe(2);
  });
});

describe("render", () => {
  const outputs = new Map<string, StepOutput>([
    ["ideas", { list: ["one", "two"] }],
    ["copy", { text: "Buy now" }],
    ["hero", { mediaIds: ["m1"], prompts: ["a tumbler on a desk"], reason: "sharpest" }],
  ]);
  it("fills inputs, items and step outputs", () => {
    expect(render("{{input.product}} / {{item}}", { product: "mug" }, outputs, "x")).toBe("mug / x");
    expect(render("{{steps.ideas}}", {}, outputs)).toBe("1. one\n2. two");
    expect(render("{{steps.copy}}", {}, outputs)).toBe("Buy now");
    expect(render("{{steps.hero.prompt}} ({{steps.hero.reason}})", {}, outputs)).toBe("a tumbler on a desk (sharpest)");
  });
  it("renders unknown references as empty", () => {
    expect(render("[{{input.nope}}][{{steps.nope}}]", {}, outputs)).toBe("[][]");
  });
});

describe("extractJson", () => {
  it("finds JSON wrapped in prose or code fences", () => {
    expect(extractJson('Sure! ```json\n["a","b"]\n```')).toEqual(["a", "b"]);
    expect(extractJson('Pick: {"index": 2, "reason": "x"} done')).toEqual({ index: 2, reason: "x" });
  });
  it("returns null when there is no valid JSON", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("[broken,")).toBeNull();
  });
});

describe("runPipeline (dry run, scripted LLM)", () => {
  it("runs the launch kit end to end, in dependency order, within budget", async () => {
    const t = validateSpec({ ...TEMPLATES.find((x) => x.id === "launch-kit")!, llm: LLM });
    const run = createRun({ kind: "pipeline", title: t.name, brief: "", pipeline: t, budget, mock: true });
    await runPipeline(run, t, findModel("scripted", "scripted")!, { product: "a mug", vibe: "calm" }, dry);

    const v = getRun(run.view.id)!;
    expect(v.status).toBe("done");
    const final = new Map(v.events.filter((e) => e.type === "step").map((e) => [e.type === "step" ? e.stepId : "", e]));
    for (const s of t.steps) expect(final.get(s.id)).toMatchObject({ state: "done" });
    expect(v.spend.images).toBe(4);
    expect(v.spend.videos).toBe(1);
    expect(v.spend.gpuUsd).toBeGreaterThan(0);
    // Result: the clip first, then the four shots.
    expect(v.result!.mediaIds).toHaveLength(5);

    // `motion` and `copy` both depend only on `hero`: they must have started before either finished.
    const seq = (id: string, state: string) => v.events.find((e) => e.type === "step" && e.stepId === id && e.state === state)!.seq;
    expect(seq("motion", "running")).toBeLessThan(seq("copy", "done"));
    expect(seq("copy", "running")).toBeLessThan(seq("motion", "done"));
  });

  it("fails a step that exceeds the budget and skips its dependents", async () => {
    const t = validateSpec({ ...TEMPLATES.find((x) => x.id === "launch-kit")!, llm: LLM });
    const run = createRun({ kind: "pipeline", title: t.name, brief: "", pipeline: t, budget: { ...budget, maxImages: 2 }, mock: true });
    await runPipeline(run, t, findModel("scripted", "scripted")!, {}, dry);
    const v = getRun(run.view.id)!;
    const last = (id: string) => [...v.events].reverse().find((e) => e.type === "step" && e.stepId === id);
    expect(v.status).toBe("failed");
    expect(last("shots")).toMatchObject({ state: "failed" });
    expect(last("hero")).toMatchObject({ state: "skipped" });
    expect(last("motion")).toMatchObject({ state: "skipped" });
    expect(v.spend.images).toBe(0);
  });

  it("stops when aborted", async () => {
    const t = validateSpec({ ...TEMPLATES.find((x) => x.id === "style-explorer")!, llm: LLM });
    const run = createRun({ kind: "pipeline", title: t.name, brief: "", pipeline: t, budget, mock: true });
    run.aborted = true;
    await runPipeline(run, t, findModel("scripted", "scripted")!, {}, dry);
    expect(getRun(run.view.id)!.status).toBe("stopped");
  });
});
