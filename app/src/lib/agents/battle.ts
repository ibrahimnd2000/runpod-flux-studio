import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";

import type { BattleView, Budget, Contestant, JudgeVerdict, LeaderboardRow, ModelOption, RunView, Side } from "../agentTypes";
import { readMedia } from "../media";
import { runAgent } from "./agent";
import type { GpuCtx } from "./gpu";
import { claudeEnabled } from "./providers";
import { createRun, getRun, listBattles, saveBattle, totalUsd, type RunState } from "./runs";

// Battleground: two agents get the same brief and the same budget and run at the
// same time. Afterwards a Claude judge looks at both deliveries (the images
// themselves, plus what each spent) and scores them; a person can overrule it
// with a vote. Votes and verdicts feed an Elo leaderboard per contestant.

const JUDGE_MODEL = "claude-opus-5-5";
const JUDGE_PRICE = { inUsd: 4, outUsd: 20 }; // $/MTok
const SIDES: Side[] = ["a", "b"];

export const judgeOption = (): ModelOption | null =>
  claudeEnabled() ? { provider: "claude", model: JUDGE_MODEL, label: "Claude Opus 5.5 (judge)", vision: true, estimatedCost: false } : null;

export const contestantKey = (c: Contestant) => `${c.provider}:${c.model}:${c.persona}`;

export function startBattle(brief: string, budget: Budget, contestants: Record<Side, Contestant>, models: Record<Side, ModelOption>, dryRun: boolean, gpuFor: (run: RunState) => GpuCtx, autoJudge: boolean): BattleView {
  const battle: BattleView = {
    id: `bat_${randomUUID().slice(0, 12)}`,
    createdAt: Date.now(),
    brief,
    budget,
    contestants,
    runs: { a: "", b: "" },
    status: "running",
  };
  const runs = SIDES.map((side) => {
    const run = createRun({ kind: "agent", title: `Battle ${side.toUpperCase()}: ${models[side].label}`, brief, contestant: contestants[side], budget, battleId: battle.id, mock: dryRun });
    battle.runs[side] = run.view.id;
    return runAgent(run, models[side], contestants[side], gpuFor(run));
  });
  saveBattle(battle);

  void Promise.all(runs).then(async () => {
    const judge = autoJudge ? judgeOption() : null;
    if (!judge) return saveBattle({ ...battle, status: "done" });
    saveBattle({ ...battle, status: "judging" });
    try {
      saveBattle({ ...battle, status: "done", judge: await judgeBattle(battle) });
    } catch (e) {
      console.error("judge failed", e);
      const msg = e instanceof Anthropic.APIError ? `Judge API error ${e.status ?? ""}` : "The judge failed.";
      saveBattle({ ...battle, status: "done", judgeError: msg });
    }
  });
  return battle;
}

const SCORE = { type: "integer", minimum: 1, maximum: 10 } as const;
const SIDE_SCORES = { type: "object", properties: { brief: SCORE, quality: SCORE, efficiency: SCORE }, required: ["brief", "quality", "efficiency"], additionalProperties: false } as const;
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    scores: { type: "object", properties: { a: SIDE_SCORES, b: SIDE_SCORES }, required: ["a", "b"], additionalProperties: false },
    winner: { type: "string", enum: ["a", "b", "tie"] },
  },
  required: ["reasoning", "scores", "winner"],
  additionalProperties: false,
} as const;

function describe(side: Side, run: RunView | undefined) {
  if (!run) return { text: `Agent ${side.toUpperCase()}: no run.`, images: [] };
  const ids = (run.result?.mediaIds ?? []).slice(0, 4);
  const images = ids
    .map((id) => readMedia(id))
    .filter((f) => f?.kind === "image")
    .map((f) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: f!.bytes.toString("base64") } }));
  const videos = ids.filter((id) => readMedia(id)?.kind === "video").length;
  const s = run.spend;
  const seconds = ((run.finishedAt ?? Date.now()) - run.createdAt) / 1000;
  return {
    text: [
      `Agent ${side.toUpperCase()} (status: ${run.status}${run.error ? `, ${run.error}` : ""})`,
      `Delivered ${images.length} image(s) shown above${videos ? ` and ${videos} video clip(s) not shown` : ""}.`,
      `Spent $${totalUsd(s).toFixed(4)} of $${run.budget.maxUsd.toFixed(2)} (GPU $${s.gpuUsd.toFixed(4)}, LLM $${s.llmUsd.toFixed(4)}), ${s.images} images rendered, ${s.toolCalls} tool calls, ${seconds.toFixed(0)} s.`,
      `Its summary: ${run.result?.text?.slice(0, 1500) || "(none)"}`,
    ].join("\n"),
    images,
  };
}

async function judgeBattle(b: BattleView): Promise<JudgeVerdict> {
  const [a, bb] = SIDES.map((side) => describe(side, getRun(b.runs[side])));
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 4000,
    system:
      "You judge a contest between two creative-production agents that received the same brief and budget. Score each from 1-10 on: brief (does the delivery answer the brief), quality (visual quality of the delivered images), efficiency (result relative to money and time spent). Pick a winner, or tie only if they are genuinely equal. Judge the images you can see, not the agents' claims about them. Keep the reasoning to 3-4 sentences.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Brief: ${b.brief}` },
          ...a.images,
          { type: "text", text: a.text },
          ...bb.images,
          { type: "text", text: bb.text },
        ],
      },
    ],
    output_config: { effort: "medium", format: { type: "json_schema", schema: VERDICT_SCHEMA as unknown as Record<string, unknown> } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (res.stop_reason === "refusal") throw new Error("judge declined");
  const text = res.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  const v = JSON.parse(text) as Omit<JudgeVerdict, "model" | "costUsd">;
  const u = res.usage;
  const costUsd = ((u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1) * JUDGE_PRICE.inUsd + u.output_tokens * JUDGE_PRICE.outUsd) / 1e6;
  return { ...v, model: res.model, costUsd };
}

export function voteBattle(id: string, vote: Side | "tie"): BattleView | null {
  const b = listBattles().find((x) => x.id === id);
  if (!b || b.status !== "done") return null;
  const next = { ...b, vote };
  saveBattle(next);
  return next;
}

/** Elo over finished battles in time order; a human vote overrides the judge. */
export function leaderboard(): LeaderboardRow[] {
  const rows = new Map<string, LeaderboardRow & { usd: number; secs: number }>();
  const row = (c: Contestant) => {
    const key = contestantKey(c);
    if (!rows.has(key)) rows.set(key, { key, contestant: c, battles: 0, wins: 0, losses: 0, ties: 0, rating: 1000, avgUsd: 0, avgSeconds: 0, usd: 0, secs: 0 });
    return rows.get(key)!;
  };
  // Oldest first (stable for equal timestamps, unlike reversing a newest-first list).
  for (const b of [...listBattles()].sort((x, y) => x.createdAt - y.createdAt)) {
    const outcome = b.vote ?? b.judge?.winner;
    if (b.status !== "done" || !outcome) continue;
    const [ra, rb] = SIDES.map((s) => row(b.contestants[s]));
    if (ra === rb) continue; // same contestant on both sides: no rating signal
    for (const [side, r] of [["a", ra], ["b", rb]] as const) {
      const run = getRun(b.runs[side]);
      r.battles += 1;
      if (run) {
        r.usd += totalUsd(run.spend);
        r.secs += ((run.finishedAt ?? run.createdAt) - run.createdAt) / 1000;
      }
    }
    const scoreA = outcome === "a" ? 1 : outcome === "b" ? 0 : 0.5;
    const expectA = 1 / (1 + 10 ** ((rb.rating - ra.rating) / 400));
    ra.rating += 32 * (scoreA - expectA);
    rb.rating += 32 * (1 - scoreA - (1 - expectA));
    if (outcome === "tie") {
      ra.ties++;
      rb.ties++;
    } else {
      const [w, l] = outcome === "a" ? [ra, rb] : [rb, ra];
      w.wins++;
      l.losses++;
    }
  }
  return [...rows.values()]
    .map(({ usd, secs, ...r }) => ({ ...r, rating: Math.round(r.rating), avgUsd: r.battles ? usd / r.battles : 0, avgSeconds: r.battles ? secs / r.battles : 0 }))
    .sort((x, y) => y.rating - x.rating);
}

