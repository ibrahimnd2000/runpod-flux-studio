import { describe, expect, it, vi } from "vitest";

import type { BattleView, Contestant, Side } from "@/lib/agentTypes";

// Battles: the Elo leaderboard, votes overriding the judge, and the judge request
// itself (mocked Anthropic SDK; it must see the delivered images).

const judgeCalls: Record<string, unknown>[] = [];
let judgeReply: Record<string, unknown> | Error = {};
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status?: number;
  }
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = class extends APIError {};
    static RateLimitError = class extends APIError {};
    beta = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          judgeCalls.push(params);
          if (judgeReply instanceof Error) throw judgeReply;
          return {
            model: "claude-opus-5-5",
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify({ reasoning: "B followed the brief.", winner: "b", scores: { a: { brief: 5, quality: 6, efficiency: 7 }, b: { brief: 8, quality: 7, efficiency: 6 } }, ...judgeReply }) }],
            usage: { input_tokens: 5000, output_tokens: 300 },
          };
        },
      },
    };
  }
  return { default: Anthropic };
});

const sdk = (await import("@anthropic-ai/sdk")).default as unknown as { APIError: new (m: string) => Error & { status?: number } };
const { contestantKey, leaderboard, rejudgeBattle, startBattle, voteBattle } = await import("@/lib/agents/battle");
const { createRun, finishRun, getBattle, saveBattle } = await import("@/lib/agents/runs");
const { findModel } = await import("@/lib/agents/providers");

const C = (persona: Contestant["persona"], model = "scripted"): Contestant => ({ provider: "scripted", model, persona });
const budget = { maxUsd: 0.5, maxImages: 4, maxVideos: 0, maxTurns: 6 };

/** A finished battle between two contestants with the given outcome. */
function fakeBattle(a: Contestant, b: Contestant, outcome: { judge?: Side | "tie"; vote?: Side | "tie" }): BattleView {
  const runs = (["a", "b"] as const).map((s) => {
    const r = createRun({ kind: "agent", title: s, brief: "x", budget, mock: true, contestant: s === "a" ? a : b });
    r.view.spend.gpuUsd = s === "a" ? 0.02 : 0.04;
    finishRun(r, "done", { text: "", mediaIds: [] });
    return r.view.id;
  });
  const battle: BattleView = {
    id: `bat_${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    brief: "x",
    budget,
    runs: { a: runs[0], b: runs[1] },
    contestants: { a, b },
    status: "done",
    vote: outcome.vote,
    judge: outcome.judge ? { winner: outcome.judge, scores: { a: { brief: 1, quality: 1, efficiency: 1 }, b: { brief: 1, quality: 1, efficiency: 1 } }, reasoning: "", model: "m", costUsd: 0 } : undefined,
  };
  saveBattle(battle);
  return battle;
}

describe("leaderboard", () => {
  it("rates with Elo (K=32), lets a vote override the judge, and ignores mirror matches", () => {
    const frugal = C("frugal");
    const perfect = C("perfectionist");
    fakeBattle(frugal, perfect, { judge: "a" }); // frugal wins: 1016 / 984
    fakeBattle(frugal, perfect, { judge: "a", vote: "b" }); // vote overrides: perfectionist wins
    fakeBattle(frugal, frugal, { judge: "a" }); // same contestant on both sides: no signal
    fakeBattle(frugal, perfect, {}); // no outcome yet: not rated

    const rows = leaderboard();
    const f = rows.find((r) => r.key === contestantKey(frugal))!;
    const p = rows.find((r) => r.key === contestantKey(perfect))!;
    expect(f).toMatchObject({ battles: 2, wins: 1, losses: 1, ties: 0 });
    expect(p).toMatchObject({ battles: 2, wins: 1, losses: 1 });
    // After 1016 vs 984, the lower-rated side winning gains more than 16.
    const expectP = 1 / (1 + 10 ** ((1016 - 984) / 400));
    expect(p.rating).toBe(Math.round(984 + 32 * (1 - expectP)));
    expect(f.rating + p.rating).toBe(2000);
    expect(f.avgUsd).toBeCloseTo(0.02);
    expect(p.avgUsd).toBeCloseTo(0.04);
  });
});

describe("voteBattle", () => {
  it("records a vote only on finished battles", () => {
    const b = fakeBattle(C("balanced"), C("frugal"), {});
    expect(voteBattle(b.id, "tie")?.vote).toBe("tie");
    saveBattle({ ...b, id: "bat_running", status: "running" });
    expect(voteBattle("bat_running", "a")).toBeNull();
    expect(voteBattle("bat_missing", "a")).toBeNull();
  });
});

describe("startBattle", () => {
  const dry = { code: "test-code", ip: "127.0.0.1", dryRun: true, aborted: () => false };
  const scripted = findModel("scripted", "scripted")!;

  async function waitDone(id: string) {
    for (let i = 0; i < 200; i++) {
      const b = getBattle(id)!;
      if (b.status === "done" || b.status === "failed") return b;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("battle did not finish");
  }

  it("runs both agents and finishes without a judge when auto-judging is off", async () => {
    const b = startBattle("a lighthouse", budget, { a: C("balanced"), b: C("frugal") }, { a: scripted, b: scripted }, true, () => dry, false);
    expect(b.runs.a).not.toBe(b.runs.b);
    const done = await waitDone(b.id);
    expect(done.judge).toBeUndefined();
  });

  it("asks the Claude judge with both deliveries' images and stores the verdict", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    judgeCalls.length = 0;
    const b = startBattle("a lighthouse", budget, { a: C("balanced"), b: C("frugal") }, { a: scripted, b: scripted }, true, () => dry, true);
    const done = await waitDone(b.id);
    vi.unstubAllEnvs();

    expect(done.judge).toMatchObject({ winner: "b", model: "claude-opus-5-5" });
    expect(done.judge!.scores.b.brief).toBe(8);
    expect(done.judge!.costUsd).toBeCloseTo((5000 * 4 + 300 * 20) / 1e6, 10);

    const req = judgeCalls[0];
    expect(req).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { format: { type: "json_schema" } } });
    const content = (req.messages as { content: { type: string }[] }[])[0].content;
    // Two images per scripted agent (dry-run placeholders), plus brief and two descriptions.
    expect(content.filter((c) => c.type === "image")).toHaveLength(4);
    expect(content.filter((c) => c.type === "text")).toHaveLength(3);
  });

  it("sends a schema structured outputs accept (no numeric bounds) and clamps the scores itself", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    judgeCalls.length = 0;
    judgeReply = { scores: { a: { brief: 0, quality: 14, efficiency: 7.6 }, b: { brief: 8, quality: 7, efficiency: 6 } } };
    const b = startBattle("a lighthouse", budget, { a: C("balanced"), b: C("frugal") }, { a: scripted, b: scripted }, true, () => dry, true);
    const done = await waitDone(b.id);
    vi.unstubAllEnvs();
    judgeReply = {};

    const schema = JSON.stringify((judgeCalls[0].output_config as { format: { schema: unknown } }).format.schema);
    for (const k of ["minimum", "maximum", "multipleOf", "minLength", "maxLength"]) expect(schema).not.toContain(`"${k}"`);
    expect(done.judge!.scores.a).toEqual({ brief: 1, quality: 10, efficiency: 8 });
  });

  it("keeps the API's reason when the judge fails, and can judge again", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const err = new sdk.APIError("output_config.format.schema: 'minimum' is not supported");
    err.status = 400;
    judgeReply = err;
    const b = startBattle("a lighthouse", budget, { a: C("balanced"), b: C("perfectionist") }, { a: scripted, b: scripted }, true, () => dry, true);
    const failed = await waitDone(b.id);
    expect(failed.judgeError).toMatch(/^Judge API error 400: .*minimum/);

    judgeReply = {};
    const again = await rejudgeBattle(b.id)!;
    vi.unstubAllEnvs();
    expect(again.judgeError).toBeUndefined();
    expect(again.judge?.winner).toBe("b");
    expect(getBattle(b.id)?.judge?.winner).toBe("b");
    expect(rejudgeBattle("bat_missing")).toBeNull();
  });
});
