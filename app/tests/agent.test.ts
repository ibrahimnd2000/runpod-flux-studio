import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Contestant, ModelOption } from "@/lib/agentTypes";
import type { GpuCtx } from "@/lib/agents/gpu";
import type { LlmSession, ToolReply, Turn } from "@/lib/agents/providers";

// The agent loop against a fake LLM: each test scripts the turns the "model"
// returns and records what the loop sends back.

const script: { turns: (Partial<Turn> & { fail?: string })[]; replies: ToolReply[][]; system?: string } = { turns: [], replies: [] };

vi.mock("@/lib/agents/providers", async (orig) => {
  const real = await orig<typeof import("@/lib/agents/providers")>();
  return {
    ...real,
    createSession: (opt: ModelOption, system: string, ...rest: unknown[]): LlmSession => {
      if (opt.provider === "scripted") return real.createSession(opt, system, ...(rest as [never, never]));
      script.system = system;
      let i = 0;
      return {
        async turn() {
          const t = script.turns[i++] ?? { texts: ["(out of script)"] };
          if (t.fail) throw new Error(t.fail);
          return { model: "fake", texts: [], thinking: [], calls: [], stop: t.calls?.length ? "tool_use" : "end", inputTokens: 100, outputTokens: 10, costUsd: 0.001, estimated: false, ms: 1, ...t };
        },
        reply(r) {
          script.replies.push(r);
        },
      };
    },
  };
});

const { runAgent } = await import("@/lib/agents/agent");
const { createRun, getRun } = await import("@/lib/agents/runs");

const fake: ModelOption = { provider: "claude", model: "fake", label: "Fake", vision: true, estimatedCost: false };
const who: Contestant = { provider: "claude", model: "fake", persona: "frugal" };
const dry: GpuCtx = { code: "test-code", ip: "127.0.0.1", dryRun: true, aborted: () => false };
const start = (budget = {}) => createRun({ kind: "agent", title: "t", brief: "a red bicycle", budget: { maxUsd: 1, maxImages: 4, maxVideos: 1, maxTurns: 6, ...budget }, mock: true });

beforeEach(() => {
  script.turns = [];
  script.replies = [];
});

describe("runAgent", () => {
  it("runs tools, returns all results of a turn in one reply, and finishes on `finish`", async () => {
    script.turns = [
      { thinking: ["plan"], texts: ["Rendering two options."], calls: [
        { id: "1", name: "generate_images", args: { prompts: ["a red bicycle by the Seine"] } },
        { id: "2", name: "estimate_cost", args: { images: 1 } },
      ] },
      { calls: [{ id: "3", name: "finish", args: { summary: "Here it is.", media_ids: [] } }] },
    ];
    const run = start();
    await runAgent(run, fake, who, dry);
    const v = getRun(run.view.id)!;

    expect(v.status).toBe("done");
    expect(script.replies).toHaveLength(1);
    expect(script.replies[0].map((r) => r.id)).toEqual(["1", "2"]);
    expect(v.result!.text).toBe("Here it is.");
    // finish with no ids falls back to everything the agent generated.
    expect(v.result!.mediaIds).toHaveLength(1);
    expect(v.spend).toMatchObject({ turns: 2, toolCalls: 3, images: 1 });
    expect(v.spend.llmUsd).toBeCloseTo(0.002);
    expect(v.events.map((e) => e.type)).toEqual(expect.arrayContaining(["status", "llm", "thinking", "text", "tool_call", "tool_result"]));
  });

  it("puts the persona and budget into the system prompt", async () => {
    script.turns = [{ texts: ["ok"] }];
    await runAgent(start({ maxUsd: 0.3 }), fake, who, dry);
    expect(script.system).toMatch(/\$0\.30/);
    expect(script.system).toMatch(/Spend as little as possible/);
    expect(script.system).toMatch(/view_image/);
  });

  it("ends when the model stops calling tools", async () => {
    script.turns = [{ texts: ["I can't help with that brief."] }];
    const run = start();
    await runAgent(run, fake, who, dry);
    expect(getRun(run.view.id)).toMatchObject({ status: "done", result: { text: "I can't help with that brief." } });
  });

  it("feeds budget refusals back to the model instead of failing", async () => {
    script.turns = [
      { calls: [{ id: "1", name: "generate_images", args: { prompts: ["a", "b", "c"].map((x) => `prompt ${x}`) } }] },
      { calls: [{ id: "2", name: "finish", args: { summary: "Gave up.", media_ids: [] } }] },
    ];
    const run = start({ maxImages: 2 });
    await runAgent(run, fake, who, dry);
    expect(script.replies[0][0].isError).toBe(true);
    expect(JSON.parse(script.replies[0][0].content).error).toMatch(/Image budget/);
    expect(getRun(run.view.id)!.status).toBe("done");
  });

  it("fails on a refusal and on a tool call cut off by max_tokens", async () => {
    script.turns = [{ stop: "refusal" }];
    const a = start();
    await runAgent(a, fake, who, dry);
    expect(getRun(a.view.id)).toMatchObject({ status: "failed", error: "The model declined this brief." });

    script.turns = [{ stop: "max_tokens", calls: [{ id: "1", name: "finish", args: {} }] }];
    const b = start();
    await runAgent(b, fake, who, dry);
    expect(getRun(b.view.id)!.error).toMatch(/cut off/);
  });

  it("stops at the turn limit", async () => {
    script.turns = Array.from({ length: 5 }, (_, i) => ({ calls: [{ id: `${i}`, name: "estimate_cost", args: { images: 1 } }] }));
    const run = start({ maxTurns: 2 });
    await runAgent(run, fake, who, dry);
    const v = getRun(run.view.id)!;
    expect(v.spend.turns).toBe(2);
    expect(v.error).toMatch(/Turn limit/);
  });

  it("records an LLM error as a failed run instead of throwing", async () => {
    script.turns = [{ texts: ["Starting."], calls: [{ id: "1", name: "estimate_cost", args: {} }] }, { fail: "Runpod vLLM 403: no access" }];
    const run = start();
    await expect(runAgent(run, fake, who, dry)).resolves.toBeUndefined();
    const v = getRun(run.view.id)!;
    expect(v.status).toBe("failed");
    expect(v.error).toMatch(/403/);
    expect(v.result!.text).toBe("Starting.");
    expect(v.events.at(-1)).toMatchObject({ type: "error" });
  });

  it("is stopped by the user between turns", async () => {
    script.turns = [{ calls: [{ id: "1", name: "estimate_cost", args: {} }] }, { calls: [{ id: "2", name: "estimate_cost", args: {} }] }];
    const run = start();
    const p = runAgent(run, fake, who, dry);
    run.aborted = true;
    await p;
    expect(getRun(run.view.id)!.status).toBe("stopped");
  });

  it("runs the scripted baseline end to end with no LLM", async () => {
    const { findModel } = await import("@/lib/agents/providers");
    const run = start();
    await runAgent(run, findModel("scripted", "scripted")!, { provider: "scripted", model: "scripted", persona: "balanced" }, dry);
    const v = getRun(run.view.id)!;
    expect(v.status).toBe("done");
    expect(v.result!.mediaIds).toHaveLength(2);
    expect(v.spend.llmUsd).toBe(0);
  });
});
