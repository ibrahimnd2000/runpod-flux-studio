"use client";

import type { EndpointView } from "@/lib/types";

import { ago, secs, shortGpu } from "./format";
import Notice from "./Notice";

const WORKER_STATES: { key: string; label: string; hint: string; tone: string }[] = [
  { key: "running", label: "Running", hint: "executing a job (billed)", tone: "bg-emerald-500" },
  { key: "idle", label: "Idle", hint: "warm, waiting for the next job until the idle timeout (billed)", tone: "bg-sky-500" },
  { key: "initializing", label: "Initializing", hint: "pulling the image or loading the model", tone: "bg-amber-500" },
  { key: "throttled", label: "Throttled", hint: "image cached on a host whose GPU is busy", tone: "bg-orange-500" },
  { key: "unhealthy", label: "Unhealthy", hint: "failed a health check", tone: "bg-red-500" },
];

const JOB_STATES = ["inQueue", "inProgress", "completed", "failed", "retried"];

export default function EndpointPanel({ ep, error }: { ep: EndpointView | null; error: string | null }) {
  return (
    <section className="card">
      <div className="flex items-baseline justify-between">
        <h2 className="card-title">Endpoint</h2>
        {ep && <span className="font-mono text-xs text-subtle">{ep.id}</span>}
      </div>
      {error && !ep && (
        <Notice tone="error" title="Couldn't load the endpoint status">
          {error} Retrying every 5 s.
        </Notice>
      )}
      {error && ep && (
        <div className="mb-4">
          <Notice tone="warn" title="Showing the last known status">
            Refresh failed ({error}). Data from {ago(ep.fetchedAt)}; retrying every 5 s.
          </Notice>
        </div>
      )}
      {!ep && !error && <p className="text-sm text-subtle">Loading…</p>}
      {ep && (
        <div className="space-y-5 text-sm">
          <div>
            <h3 className="sub">Workers</h3>
            <ul className="space-y-1.5">
              {WORKER_STATES.map((s) => (
                <li key={s.key} className="flex items-center gap-2" title={s.hint}>
                  <span className={`h-2 w-2 rounded-full ${s.tone}`} />
                  <span className="flex-1">{s.label}</span>
                  <span className="font-mono">{ep.health?.workers[s.key] ?? 0}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-subtle">
              min {ep.workersMin ?? "–"} · max {ep.workersMax ?? "–"} · idle timeout {ep.idleTimeoutS ?? "–"} s
            </p>
          </div>

          <div>
            <h3 className="sub">Jobs (Runpod counters)</h3>
            <div className="grid grid-cols-5 gap-1 text-center">
              {JOB_STATES.map((k) => (
                <div key={k} className="rounded-md bg-muted py-1.5">
                  <div className="font-mono text-base">{ep.health?.jobs[k] ?? 0}</div>
                  <div className="text-[10px] text-subtle">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="sub">Configuration</h3>
            <dl className="kv">
              <dt>Image</dt>
              <dd className="font-mono break-all">{ep.image?.split("/").pop() ?? "–"}</dd>
              <dt>GPU pools</dt>
              <dd className="font-mono">{ep.gpuPools.join(", ") || "–"}</dd>
              <dt>Eligible GPUs</dt>
              <dd>{ep.gpuTypes.map(shortGpu).join(", ") || "–"}</dd>
              <dt>Excluded</dt>
              <dd>{ep.excludedTypes.map(shortGpu).join(", ") || "none"}</dd>
              <dt>Autoscaling</dt>
              <dd>
                {ep.scaling?.type === "QUEUE_DELAY"
                  ? `add a worker when a job waits > ${ep.scaling.queueDelay} s`
                  : (ep.scaling?.type ?? "–")}
              </dd>
              <dt>FlashBoot</dt>
              <dd>{ep.flashboot ?? "–"}</dd>
              <dt>Execution timeout</dt>
              <dd>{secs(ep.executionTimeoutMs, 0)}</dd>
            </dl>
          </div>
          <p className="text-xs text-subtle">Live from Runpod /health and REST v2 · refreshes every 5 s</p>
        </div>
      )}
    </section>
  );
}
