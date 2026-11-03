import "server-only";

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { BattleView, NewRunEvent, RunEvent, RunResult, RunStatus, RunSummary, RunView, Spend } from "../agentTypes";
import { config } from "../config";

// Pipeline / agent runs and battles. A run executes in this Node process (not in
// the browser), so closing the tab doesn't stop it; the browser polls
// /api/runs/[id] for new events. Same persistence pattern as store.ts: memory,
// plus an append-only JSONL file on DATA_DIR (last line per id wins).

const MAX_KEPT = 200;
// Every run can spend GPU and LLM credits; cap how many run at once.
export const MAX_ACTIVE = Number(process.env.AGENT_MAX_ACTIVE_RUNS) || 4;

const runsFile = config.dataDir ? join(config.dataDir, "agent-runs.jsonl") : "";
const battlesFile = config.dataDir ? join(config.dataDir, "battles.jsonl") : "";

export interface RunState {
  view: RunView;
  aborted: boolean;
}

function readJsonl<T extends { id: string }>(file: string): Map<string, T> {
  const out = new Map<string, T>();
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as T;
        out.set(r.id, r);
      } catch {
        // skip a torn last line
      }
    }
  }
  return out;
}

function append(file: string, record: unknown) {
  if (!file) return;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n");
  } catch (e) {
    console.error(`could not persist to ${file}`, e);
  }
}

const g = globalThis as unknown as {
  __fluxRuns?: { live: Map<string, RunState>; done: Map<string, RunView>; battles: Map<string, BattleView> };
};
const store = (g.__fluxRuns ??= {
  live: new Map(),
  done: readJsonl<RunView>(runsFile),
  battles: readJsonl<BattleView>(battlesFile),
});

export const emptySpend = (): Spend => ({
  gpuUsd: 0,
  llmUsd: 0,
  llmEstimatedUsd: 0,
  images: 0,
  videos: 0,
  toolCalls: 0,
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
});

export const activeRuns = () => [...store.live.values()].filter((r) => r.view.status === "running").length;

export function createRun(init: Omit<RunView, "id" | "createdAt" | "status" | "spend" | "events">): RunState {
  const state: RunState = {
    view: { ...init, id: `run_${randomUUID().slice(0, 12)}`, createdAt: Date.now(), status: "running", spend: emptySpend(), events: [] },
    aborted: false,
  };
  store.live.set(state.view.id, state);
  return state;
}

export function emit(state: RunState, event: NewRunEvent) {
  const events = state.view.events;
  events.push({ ...event, seq: events.length, t: Date.now() } as RunEvent);
}

export function addSpend(state: RunState, delta: Partial<Spend>) {
  const s = state.view.spend;
  for (const [k, v] of Object.entries(delta) as [keyof Spend, number][]) s[k] += v;
}

export const totalUsd = (s: Spend) => s.gpuUsd + s.llmUsd;

export function finishRun(state: RunState, status: RunStatus, result?: RunResult, error?: string) {
  const v = state.view;
  if (v.status !== "running") return;
  Object.assign(v, { status, finishedAt: Date.now(), result, error });
  store.done.set(v.id, v);
  store.live.delete(v.id);
  while (store.done.size > MAX_KEPT) store.done.delete(store.done.keys().next().value!);
  append(runsFile, v);
}

export function getRunState(id: string) {
  return store.live.get(id);
}

export function getRun(id: string): RunView | undefined {
  return store.live.get(id)?.view ?? store.done.get(id);
}

export function stopRun(id: string): boolean {
  const s = store.live.get(id);
  if (!s) return false;
  s.aborted = true;
  return true;
}

export function listRuns(limit = 30): RunSummary[] {
  const all = [...[...store.live.values()].map((s) => s.view), ...store.done.values()];
  return all
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((v): RunSummary => {
      const rest: Partial<RunView> = { ...v };
      delete rest.events;
      delete rest.pipeline;
      return rest as RunSummary;
    });
}

// ------------------------------- battles ---------------------------------- //
export function saveBattle(b: BattleView) {
  store.battles.set(b.id, b);
  append(battlesFile, b);
}

export const getBattle = (id: string) => store.battles.get(id);

export const listBattles = () => [...store.battles.values()].sort((a, b) => b.createdAt - a.createdAt);
