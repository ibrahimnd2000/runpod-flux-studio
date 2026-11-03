import { describe, expect, it } from "vitest";

import type { Budget } from "@/lib/agentTypes";
import type { GpuCtx } from "@/lib/agents/gpu";
import { addSpend, createRun, emit, finishRun, getRun, listRuns, stopRun, totalUsd } from "@/lib/agents/runs";
import { executeTool, imageCost, toolCatalog, toolSpecs } from "@/lib/agents/tools";
import { saveMedia } from "@/lib/media";

const dry: GpuCtx = { code: "test-code", ip: "127.0.0.1", dryRun: true, aborted: () => false };
const newRun = (b: Partial<Budget> = {}) =>
  createRun({ kind: "agent", title: "t", brief: "b", budget: { maxUsd: 1, maxImages: 4, maxVideos: 1, maxTurns: 8, ...b }, mock: true });
const call = (name: string, args: unknown) => ({ id: `c-${Math.random()}`, name, args });
const body = (o: { reply: { content: string } }) => JSON.parse(o.reply.content);

describe("tool specs", () => {
  it("offers view_image only to models that can see", () => {
    expect(toolSpecs({ vision: false, dryRun: true }).map((t) => t.name)).not.toContain("view_image");
    expect(toolSpecs({ vision: true, dryRun: true }).map((t) => t.name)).toContain("view_image");
  });

  it("hides animate_image when no video endpoint is configured (unless dry run)", () => {
    expect(toolSpecs({ vision: true, dryRun: false }).map((t) => t.name)).not.toContain("animate_image");
    expect(toolSpecs({ vision: true, dryRun: true }).map((t) => t.name)).toContain("animate_image");
  });

  it("exports plain JSON Schemas with no $schema key", () => {
    for (const t of toolSpecs({ vision: true, dryRun: true })) {
      expect(t.schema.type).toBe("object");
      expect(t.schema).not.toHaveProperty("$schema");
      expect(t.description.length).toBeGreaterThan(10);
    }
    expect(toolCatalog().find((t) => t.name === "view_image")?.vision).toBe(true);
  });

  it("prices draft images below final ones", () => {
    expect(imageCost({ width: 768, height: 768, steps: 16 })).toBeLessThan(imageCost({ width: 1024, height: 1024, steps: 28 }) / 2);
  });
});

describe("executeTool", () => {
  it("refuses unknown tools and tools the model wasn't given", async () => {
    const run = newRun();
    expect((await executeTool(call("rm_rf", {}), run, dry, true)).reply.isError).toBe(true);
    expect((await executeTool(call("view_image", { media_id: "x" }), run, dry, false)).reply.isError).toBe(true);
  });

  it("reports invalid arguments with the failing path", async () => {
    const o = await executeTool(call("generate_images", { prompts: [] }), newRun(), dry, false);
    expect(o.reply.isError).toBe(true);
    expect(body(o).error).toMatch(/prompts/);
  });

  it("generates images in a dry run and charges the run", async () => {
    const run = newRun();
    const o = await executeTool(call("generate_images", { prompts: ["a red bicycle in Paris", "the same at night"] }), run, dry, false);
    expect(o.reply.isError).toBeFalsy();
    expect(o.mediaIds).toHaveLength(2);
    expect(body(o).images).toHaveLength(2);
    expect(run.view.spend.images).toBe(2);
    expect(run.view.spend.gpuUsd).toBeCloseTo(2 * 0.0107, 6);
    expect(body(o).budget_left.images).toBe(2);
  });

  it("refuses calls that exceed the image or dollar budget, without spending", async () => {
    const run = newRun({ maxImages: 1 });
    const o = await executeTool(call("generate_images", { prompts: ["a", "b"].map((x) => `prompt ${x}`) }), run, dry, false);
    expect(o.reply.isError).toBe(true);
    expect(body(o).error).toMatch(/Image budget/);

    const poor = newRun({ maxUsd: 0.005 });
    const p = await executeTool(call("generate_images", { prompts: ["prompt a"] }), poor, dry, false);
    expect(body(p).error).toMatch(/Budget/);
    // Draft quality fits where final doesn't.
    const d = await executeTool(call("generate_images", { prompts: ["prompt a"], quality: "draft" }), poor, dry, false);
    expect(d.reply.isError).toBeFalsy();
    expect(run.view.spend.images + poor.view.spend.images).toBe(1);
  });

  it("animates a library image in a dry run and enforces the clip budget", async () => {
    const run = newRun();
    const img = await executeTool(call("generate_images", { prompts: ["prompt a"] }), run, dry, false);
    const id = img.mediaIds![0];
    const a = await executeTool(call("animate_image", { media_id: id, motion: "slow push-in", seconds: 2 }), run, dry, false);
    expect(a.reply.isError).toBeFalsy();
    expect(run.view.spend.videos).toBe(1);
    const again = await executeTool(call("animate_image", { media_id: id, motion: "slow push-in" }), run, dry, false);
    expect(body(again).error).toMatch(/Video budget/);
    const missing = await executeTool(call("animate_image", { media_id: "missing-id-123", motion: "pan" }), newRun(), dry, false);
    expect(body(missing).error).toMatch(/No library image/);
  });

  it("view_image returns the picture as an attachment", async () => {
    saveMedia({ id: "view-test-0001", kind: "image", prompt: "p", width: 1, height: 1, steps: 1, createdAt: 1 }, Buffer.from("img").toString("base64"));
    const o = await executeTool(call("view_image", { media_id: "view-test-0001" }), newRun(), dry, true);
    expect(o.reply.images?.[0]).toMatchObject({ mime: "image/jpeg", data: Buffer.from("img").toString("base64") });
  });

  it("search_library ranks by matching words and is free", async () => {
    saveMedia({ id: "search-test-01", kind: "image", prompt: "a lighthouse in a storm", width: 1, height: 1, steps: 1, createdAt: 5 }, "aGk=");
    saveMedia({ id: "search-test-02", kind: "image", prompt: "a quiet lighthouse", width: 1, height: 1, steps: 1, createdAt: 6 }, "aGk=");
    const run = newRun();
    const o = await executeTool(call("search_library", { query: "lighthouse storm" }), run, dry, false);
    expect(body(o).items[0].media_id).toBe("search-test-01");
    expect(totalUsd(run.view.spend)).toBe(0);
  });

  it("estimate_cost and check_endpoints are free and never throw", async () => {
    const run = newRun();
    const e = await executeTool(call("estimate_cost", { images: 4, video_seconds: 2 }), run, dry, false);
    expect(body(e).usd).toBeCloseTo(4 * 0.0107 + 2 * 0.021, 4);
    const c = await executeTool(call("check_endpoints", {}), run, dry, false);
    expect(body(c).image_endpoint.configured).toBe(false);
    expect(totalUsd(run.view.spend)).toBe(0);
  });

  it("finish carries the delivery", async () => {
    const o = await executeTool(call("finish", { summary: "done", media_ids: ["a1"] }), newRun(), dry, false);
    expect(o.finish).toEqual({ summary: "done", mediaIds: ["a1"] });
  });
});

describe("run store", () => {
  it("numbers events, sums spend and finishes once", () => {
    const run = newRun();
    emit(run, { type: "status", text: "one" });
    emit(run, { type: "text", text: "two" });
    expect(run.view.events.map((e) => e.seq)).toEqual([0, 1]);
    addSpend(run, { gpuUsd: 0.1, images: 2 });
    addSpend(run, { llmUsd: 0.05, images: 1 });
    expect(totalUsd(run.view.spend)).toBeCloseTo(0.15);
    expect(run.view.spend.images).toBe(3);
    finishRun(run, "done", { text: "ok", mediaIds: [] });
    finishRun(run, "failed");
    expect(getRun(run.view.id)?.status).toBe("done");
  });

  it("lists runs newest first, without their events", () => {
    const a = newRun();
    const listed = listRuns().find((r) => r.id === a.view.id)!;
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("events");
  });

  it("stops only live runs", () => {
    const run = newRun();
    expect(stopRun(run.view.id)).toBe(true);
    expect(run.aborted).toBe(true);
    finishRun(run, "stopped");
    expect(stopRun(run.view.id)).toBe(false);
  });
});
