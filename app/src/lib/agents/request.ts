import "server-only";

import type { Budget, Contestant, PersonaId } from "../agentTypes";
import { config } from "../config";
import { checkCode, clientIp, LimitError, startOfUtcDay } from "../limits";
import type { GpuCtx } from "./gpu";
import { findModel } from "./providers";
import { activeRuns, listRuns, MAX_ACTIVE, type RunState } from "./runs";

// Request handling shared by the pipeline, agent and battle routes: access code,
// concurrency and daily caps, budget clamping, and the GPU context for tools.

const num = (name: string, fallback: number) => Number(process.env[name]) || fallback;

export const DEFAULT_BUDGET: Budget = { maxUsd: 0.25, maxImages: 4, maxVideos: 1, maxTurns: 8 };
// Hard ceilings per run, whatever the browser sends.
export const MAX_BUDGET: Budget = {
  maxUsd: num("AGENT_MAX_USD_PER_RUN", 1),
  maxImages: num("AGENT_MAX_IMAGES_PER_RUN", 8),
  maxVideos: num("AGENT_MAX_VIDEOS_PER_RUN", 1),
  maxTurns: num("AGENT_MAX_TURNS", 12),
};
const DAILY_RUNS = num("AGENT_DAILY_RUNS", 40);

export function parseBudget(raw: unknown): Budget {
  const b = (raw ?? {}) as Partial<Record<keyof Budget, unknown>>;
  const pick = (k: keyof Budget, lo: number) => {
    const v = Number(b[k]);
    return Number.isFinite(v) ? Math.min(Math.max(v, lo), MAX_BUDGET[k]) : Math.min(DEFAULT_BUDGET[k], MAX_BUDGET[k]);
  };
  return {
    maxUsd: +pick("maxUsd", 0.01).toFixed(2),
    maxImages: Math.round(pick("maxImages", 0)),
    maxVideos: Math.round(pick("maxVideos", 0)),
    maxTurns: Math.round(pick("maxTurns", 1)),
  };
}

/** Without a configured image endpoint every run is a dry run. */
export const gpuConfigured = () => !!(config.apiKey && config.endpointId);

/** Access code, then the concurrency and daily run caps. `runs` = how many runs this request starts. */
export function checkRunAccess(req: Request, runs = 1) {
  checkCode(req.headers.get("x-access-code"));
  if (activeRuns() + runs > MAX_ACTIVE) throw new LimitError(`At most ${MAX_ACTIVE} runs at a time; wait for one to finish.`, 429);
  const today = listRuns(500).filter((r) => r.createdAt >= startOfUtcDay()).length;
  if (today + runs > DAILY_RUNS) throw new LimitError(`Daily demo cap of ${DAILY_RUNS} orchestration runs reached; resets 00:00 UTC.`, 429);
}

export function gpuContext(req: Request, dryRun: boolean, run?: RunState): GpuCtx {
  return {
    code: req.headers.get("x-access-code"),
    ip: clientIp(req),
    dryRun: dryRun || !gpuConfigured(),
    aborted: () => !!run?.aborted,
  };
}

const PERSONA_IDS: PersonaId[] = ["balanced", "frugal", "perfectionist"];

export function parseContestant(raw: unknown): { contestant: Contestant; model: NonNullable<ReturnType<typeof findModel>> } {
  const c = (raw ?? {}) as Partial<Contestant>;
  const model = findModel(c.provider!, String(c.model ?? ""));
  if (!model) throw new LimitError(`Model ${c.provider}/${c.model} isn't available on this deployment.`, 400);
  const persona = PERSONA_IDS.includes(c.persona as PersonaId) ? (c.persona as PersonaId) : "balanced";
  return { contestant: { provider: model.provider, model: model.model, persona }, model };
}

export function parseBrief(raw: unknown): string {
  const brief = typeof raw === "string" ? raw.trim().slice(0, 2000) : "";
  if (brief.length < 8) throw new LimitError("Write a brief of at least a few words.", 400);
  return brief;
}

export function errorResponse(e: unknown, what: string) {
  if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
  console.error(`${what} failed`, e);
  return Response.json({ error: `Could not start the ${what}.` }, { status: 500 });
}
