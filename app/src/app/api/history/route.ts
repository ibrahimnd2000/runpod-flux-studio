import { connection } from "next/server";

import { config } from "@/lib/config";
import { startOfUtcDay } from "@/lib/limits";
import { pricesChecked } from "@/lib/prices";
import { history, submittedSince } from "@/lib/store";
import type { HistoryView } from "@/lib/types";

function pct(values: number[], q: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const k = (v.length - 1) * q;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, v.length - 1);
  return v[lo] + (v[hi] - v[lo]) * (k - lo);
}

export async function GET() {
  await connection(); // live data: never prerender at build time
  const jobs = history();
  const ok = jobs.filter((j) => j.status === "COMPLETED" && !j.error);
  const warm = ok.filter((j) => !j.output?.worker?.cold_start);
  const cold = ok.filter((j) => j.output?.worker?.cold_start);
  const costs = ok.map((j) => j.costUsd).filter((c): c is number => c !== undefined);

  const view: HistoryView = {
    jobs: jobs.slice(0, 100),
    stats: {
      completed: ok.length,
      failed: jobs.length - ok.length,
      cold: cold.length,
      warmExecP50Ms: pct(warm.flatMap((j) => j.executionMs ?? []), 0.5),
      warmExecP90Ms: pct(warm.flatMap((j) => j.executionMs ?? []), 0.9),
      coldDelayP50Ms: pct(cold.flatMap((j) => j.delayMs ?? []), 0.5),
      avgCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      totalCostUsd: costs.reduce((a, b) => a + b, 0),
    },
    limits: {
      dailyCap: config.dailyCap,
      usedToday: submittedSince(startOfUtcDay()),
      maxSide: config.maxSide,
      maxSteps: config.maxSteps,
    },
    pricesChecked,
  };
  return Response.json(view);
}
