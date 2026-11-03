import { connection } from "next/server";

import { config } from "@/lib/config";
import { endpointConfig, endpointHealth, gpuCatalog, type GpuCatalogEntry } from "@/lib/runpod";
import type { EndpointView } from "@/lib/types";

// Live endpoint state for the dashboard: worker/job counts from /health plus the
// endpoint's configuration (GPU pools, exclusions, scaling) from REST v2.
// Cached for a few seconds so many open dashboards don't hammer the API.

let cache: { at: number; view: EndpointView } | null = null;
let poolMembers: Map<string, string[]> | null = null;

async function membersByPool() {
  if (poolMembers) return poolMembers;
  const raw = await gpuCatalog();
  const list: GpuCatalogEntry[] = Array.isArray(raw) ? raw : (raw.gpus ?? []);
  poolMembers = new Map();
  for (const g of list) if (g.pool) poolMembers.set(g.pool, [...(poolMembers.get(g.pool) ?? []), g.id]);
  return poolMembers;
}

export async function GET() {
  await connection(); // live data: never prerender at build time
  if (cache && Date.now() - cache.at < 4000) return Response.json(cache.view);
  try {
    const [cfg, health, pools] = await Promise.all([
      endpointConfig(),
      endpointHealth().catch(() => null),
      membersByPool().catch(() => new Map<string, string[]>()),
    ]);
    const excluded = cfg.gpu?.excludedTypes ?? [];
    const view: EndpointView = {
      id: config.endpointId,
      name: cfg.name,
      image: cfg.image,
      gpuPools: cfg.gpu?.pools ?? [],
      gpuTypes: (cfg.gpu?.pools ?? []).flatMap((p) => pools.get(p) ?? []).filter((t) => !excluded.includes(t)),
      excludedTypes: excluded,
      workersMin: cfg.workers?.min,
      workersMax: cfg.workers?.max,
      idleTimeoutS: cfg.workers?.idleTimeout,
      flashboot: cfg.flashboot,
      scaling: cfg.scaling,
      executionTimeoutMs: cfg.timeout,
      health,
      fetchedAt: Date.now(),
    };
    cache = { at: Date.now(), view };
    return Response.json(view);
  } catch (e) {
    console.error("endpoint failed", e);
    return Response.json({ error: "Could not read the endpoint from Runpod." }, { status: 502 });
  }
}
