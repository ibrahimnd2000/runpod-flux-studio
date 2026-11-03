"use client";

import { useEffect, useState } from "react";

import type { JobView } from "@/lib/types";

import { secs, shortGpu, usd } from "./format";

const STAGES = ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"] as const;

/** Where the time went for one request, and which worker served it. */
export default function JobDetails({ job }: { job: JobView }) {
  const [now, setNow] = useState(job.submittedAt);
  const running = !["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  const w = job.output?.worker;
  const t = job.output?.timings;
  const elapsed = job.clientWallMs ?? now - job.submittedAt;
  const stage = STAGES.indexOf(job.status as (typeof STAGES)[number]);
  // Client wall time minus Runpod's own numbers = network + polling overhead.
  const overhead =
    job.clientWallMs !== undefined && job.delayMs !== undefined && job.executionMs !== undefined
      ? Math.max(job.clientWallMs - job.delayMs - job.executionMs, 0)
      : undefined;

  return (
    <div className="space-y-4 text-sm">
      <ol className="flex items-center gap-2 text-xs">
        {STAGES.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 font-medium ${
                job.status === "FAILED" && i === Math.max(stage, 0)
                  ? "bg-red-500/15 text-red-600"
                  : i < stage || job.status === "COMPLETED"
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                    : i === stage
                      ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                      : "bg-muted text-subtle"
              }`}
            >
              {s.replace("_", " ").toLowerCase()}
            </span>
            {i < STAGES.length - 1 && <span className="text-subtle">→</span>}
          </li>
        ))}
        <span className="ml-auto font-mono text-subtle">{secs(elapsed)}</span>
      </ol>

      {job.progress && job.status === "IN_PROGRESS" && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-sky-500 transition-all"
            style={{ width: `${(100 * job.progress.step) / job.progress.total_steps}%` }}
          />
        </div>
      )}

      <dl className="kv">
        <dt>Queue + cold start</dt>
        <dd title="Runpod delayTime: time in queue, including image pull, container start and model load on a cold worker">
          {secs(job.delayMs)}
        </dd>
        <dt>Execution</dt>
        <dd title="Runpod executionTime: billed handler time">{secs(job.executionMs)}</dd>
        <dt className="pl-3">↳ inference</dt>
        <dd>{secs(t?.inference_ms)}</dd>
        <dt className="pl-3">↳ encode</dt>
        <dd>{secs(t?.encode_ms, 2)}</dd>
        <dt>Network + polling</dt>
        <dd>{secs(overhead)}</dd>
        <dt>Cost (exec × GPU $/s)</dt>
        <dd>{usd(job.costUsd)}</dd>
      </dl>

      {w && (
        <dl className="kv">
          <dt>GPU</dt>
          <dd>{shortGpu(w.gpu)}</dd>
          <dt>Peak VRAM</dt>
          <dd>
            {w.peak_vram_gb} / {w.vram_total_gb} GB
          </dd>
          <dt>Worker</dt>
          <dd className="font-mono">{w.id ?? "–"}</dd>
          <dt>Cold start</dt>
          <dd>{w.cold_start ? `yes (model load ${secs(w.model_load_ms)})` : `no (job #${w.jobs_served} on this worker)`}</dd>
          <dt>Seed</dt>
          <dd className="font-mono">{job.output?.seed}</dd>
        </dl>
      )}
      {job.output?.notes?.length ? <p className="text-xs text-subtle">{job.output.notes.join("; ")}</p> : null}
    </div>
  );
}
