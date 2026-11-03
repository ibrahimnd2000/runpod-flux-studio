"use client";

import { Clock, Cpu, DollarSign, Gauge, Layers, Server, Snowflake, Timer } from "lucide-react";

import type { JobView } from "@/lib/types";

import { secs, shortGpu, usd } from "../format";
import Notice from "../Notice";
import { Badge, EmptyState, Stat } from "../ui/primitives";
import { Term } from "../ui/Tooltip";
import { isBulkJobDone, type BulkJob, type BulkRun, type Problem } from "./useJobs";

export default function BulkResults({ run, now, problem }: { run: BulkRun | null; now: number; problem: Problem | null }) {
  if (!run)
    return (
      <>
        {problem && <Notice tone={problem.tone} title={problem.title}>{problem.detail}</Notice>}
        {!problem && (
          <EmptyState icon={<Layers className="h-8 w-8" />} title="Bulk results will appear here">
            One prompt per line. Each image becomes its own Runpod job and they all start together, so you can watch the
            autoscaler spread them across GPU workers.
          </EmptyState>
        )}
      </>
    );

  const s = summarize(run, now);
  const allDone = run.jobs.every(isBulkJobDone);
  return (
    <div className="space-y-4">
      {problem && <Notice tone={problem.tone} title={problem.title}>{problem.detail}</Notice>}
      <div className="flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-accent transition-all duration-500" style={{ width: `${(s.done / run.jobs.length) * 100}%` }} />
        </div>
        <span className="font-mono text-xs text-subtle">
          {s.done}/{run.jobs.length} {allDone ? "done" : "running"}
          {s.failed ? ` · ${s.failed} failed` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat icon={<Clock className="h-3.5 w-3.5" />} label="Total time" value={secs(s.wallMs)} />
        <Stat icon={<Cpu className="h-3.5 w-3.5" />} label={<Term term="execution">GPU time</Term>} value={secs(s.gpuMs)} sub="sum of all jobs" />
        <Stat
          icon={<Gauge className="h-3.5 w-3.5" />}
          label={<Term term="speedup">Speed-up</Term>}
          value={s.speedup ? `${s.speedup.toFixed(2)}×` : "–"}
          sub="vs one at a time"
        />
        <Stat icon={<DollarSign className="h-3.5 w-3.5" />} label={<Term term="cost">Cost</Term>} value={usd(s.costUsd)} />
        <Stat icon={<Server className="h-3.5 w-3.5" />} label={<Term term="workers">Workers used</Term>} value={s.workers} />
        <Stat icon={<Snowflake className="h-3.5 w-3.5" />} label={<Term term="coldStart">Cold starts</Term>} value={s.cold} />
        <Stat icon={<Timer className="h-3.5 w-3.5" />} label={<Term term="queue">Max queue wait</Term>} value={secs(s.maxDelayMs)} />
        <Stat icon={<Layers className="h-3.5 w-3.5" />} label="GPUs" value={<span className="text-sm">{s.gpus || "–"}</span>} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
        {run.jobs.map((j, i) => (
          <JobCard key={j.id ?? `failed-${i}`} job={j} index={i} />
        ))}
      </div>
    </div>
  );
}

function summarize(run: BulkRun, now: number) {
  const views = run.jobs.map((j) => j.view).filter((v): v is JobView => !!v);
  const completed = views.filter((v) => v.status === "COMPLETED" && !v.error);
  const allDone = run.jobs.every(isBulkJobDone);
  const lastFinish = Math.max(
    run.submittedAt,
    ...views.filter((v) => v.clientWallMs !== undefined).map((v) => v.submittedAt + v.clientWallMs!),
  );
  const wallMs = (allDone ? lastFinish : Math.max(now, lastFinish)) - run.submittedAt;
  const gpuMs = completed.reduce((a, v) => a + (v.executionMs ?? 0), 0);
  return {
    done: run.jobs.filter(isBulkJobDone).length,
    failed: run.jobs.filter((j) => j.error || !j.id).length,
    wallMs,
    gpuMs,
    // > 1 means jobs really ran at the same time on several workers.
    speedup: completed.length && wallMs > 0 ? gpuMs / wallMs : null,
    workers: new Set(completed.map((v) => v.output?.worker?.id).filter(Boolean)).size,
    cold: completed.filter((v) => v.output?.worker?.cold_start).length,
    maxDelayMs: views.reduce((m, v) => Math.max(m, v.delayMs ?? 0), 0) || null,
    costUsd: completed.reduce((a, v) => a + (v.costUsd ?? 0), 0),
    gpus: [...new Set(completed.map((v) => shortGpu(v.output?.worker?.gpu)))].join(", "),
  };
}

function JobCard({ job, index }: { job: BulkJob; index: number }) {
  const v = job.view;
  const w = v?.output?.worker;
  const status = job.error
    ? "Failed"
    : !v || v.status === "IN_QUEUE"
      ? "Queued"
      : v.status === "IN_PROGRESS"
        ? v.progress
          ? `Step ${v.progress.step}/${v.progress.total_steps}`
          : "Starting"
        : v.status === "COMPLETED"
          ? "Done"
          : v.status.toLowerCase();
  const tone = job.error ? "red" : status === "Done" ? "green" : status === "Queued" ? "neutral" : "blue";
  const progress = v?.progress ? v.progress.step / v.progress.total_steps : 0;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background/50">
      <div className="relative bg-muted" style={{ aspectRatio: job.input.width / job.input.height }}>
        {job.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={job.image} alt={job.input.prompt} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center p-2 text-center text-xs text-subtle">
            {job.error ?? (status === "Queued" ? "Waiting for a GPU…" : status)}
          </div>
        )}
        <div className="absolute inset-x-2 top-2 flex justify-between">
          <Badge tone={tone} className="backdrop-blur">{status}</Badge>
          <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">#{index + 1}</span>
        </div>
        {w?.cold_start && (
          <Badge tone="amber" className="absolute bottom-2 left-2">
            cold start
          </Badge>
        )}
        {v?.status === "IN_PROGRESS" && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
            <div className="h-full bg-accent transition-all" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>
      <div className="space-y-1 p-2.5 text-[11px]">
        <p className="truncate" title={job.input.prompt}>
          {job.input.prompt}
        </p>
        <div className="flex justify-between text-subtle">
          <span>{w ? shortGpu(w.gpu) : "–"}</span>
          <span className="font-mono">{v?.executionMs ? secs(v.executionMs) : ""}</span>
        </div>
        <div className="flex justify-between text-subtle">
          <span className="truncate font-mono" title={w?.id ?? undefined}>
            {w?.id ? `worker ${w.id.slice(0, 6)}` : ""}
          </span>
          <span className="font-mono">{v?.delayMs !== undefined ? `queue ${secs(v.delayMs)}` : ""}</span>
        </div>
      </div>
    </div>
  );
}
