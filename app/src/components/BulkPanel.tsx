"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { TERMINAL, type GenerateInput, type JobView } from "@/lib/types";

import { getJson, isTransient } from "./api";
import { secs, shortGpu, usd } from "./format";
import { PRESETS } from "./GeneratePanel";
import Notice from "./Notice";
import { useAccessCode } from "./useAccessCode";

interface BulkJob {
  id: string | null;
  input: GenerateInput;
  view?: JobView;
  image?: string;
  error?: string;
  failures: number;
}

interface Run {
  submittedAt: number;
  jobs: BulkJob[];
}

const POLL_MS = 1500;
const MAX_POLL_FAILURES = 40;

const isDone = (j: BulkJob) => !j.id || !!j.error || (!!j.view && TERMINAL.includes(j.view.status));

export default function BulkPanel({ maxSide, maxSteps, bulkMax, onFinished }: {
  maxSide: number;
  maxSteps: number;
  bulkMax: number;
  onFinished: () => void;
}) {
  const [promptsText, setPromptsText] = useState(PRESETS.join("\n"));
  const [variations, setVariations] = useState(2);
  const [side, setSide] = useState(1024);
  const [steps, setSteps] = useState(28);
  const { code, setCode, remember } = useAccessCode();
  const [run, setRun] = useState<Run | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(0);
  const runRef = useRef<Run | null>(null);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const prompts = promptsText.split("\n").map((p) => p.trim()).filter(Boolean);
  const total = prompts.length * variations;
  const running = !!run && !run.jobs.every(isDone);

  // One poller for the whole run: refresh every unfinished job, then stop.
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(async () => {
      setNow(Date.now());
      const current = runRef.current;
      if (!current) return;
      const updates = await Promise.all(
        current.jobs.map(async (j): Promise<BulkJob> => {
          if (isDone(j)) return j;
          const res = await getJson<JobView>(`/api/jobs/${j.id}`);
          if (!res.ok) {
            const failures = j.failures + 1;
            if (isTransient(res.status) && failures < MAX_POLL_FAILURES) return { ...j, failures };
            return { ...j, failures, error: res.error ?? "Lost track of this job." };
          }
          const view = res.data;
          return {
            ...j,
            failures: 0,
            view,
            image: view.output?.image ?? j.image,
            error: TERMINAL.includes(view.status) && (view.status !== "COMPLETED" || view.error)
              ? (view.error ?? view.status.toLowerCase())
              : undefined,
          };
        }),
      );
      setRun((r) => (r && r.submittedAt === current.submittedAt ? { ...r, jobs: updates } : r));
      if (updates.every(isDone)) onFinished();
    }, POLL_MS);
    return () => clearInterval(tick);
  }, [running, onFinished]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);
    setSubmitting(true);
    remember(code);
    const res = await getJson<{ submittedAt: number; jobs: { id: string | null; input: GenerateInput; error?: string }[] }>(
      "/api/bulk",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-access-code": code },
        body: JSON.stringify({ prompts, variations, width: side, height: side, num_inference_steps: steps }),
      },
    );
    setSubmitting(false);
    if (!res.ok) {
      setProblem(res.error ?? "Couldn't start the bulk run.");
      return;
    }
    setNow(Date.now());
    setRun({
      submittedAt: Date.now(),
      jobs: res.data.jobs.map((j) => ({ id: j.id, input: j.input, error: j.error, failures: 0 })),
    });
  }

  const summary = useMemo(() => summarize(run, now), [run, now]);

  return (
    <div>
      <form onSubmit={submit} className="space-y-3">
        <textarea
          className="input h-32 resize-y font-mono text-xs"
          value={promptsText}
          onChange={(e) => setPromptsText(e.target.value)}
          aria-label="Prompts, one per line"
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="field">
            <span>Variations per prompt</span>
            <input
              className="input"
              type="number"
              min={1}
              max={bulkMax}
              value={variations}
              onChange={(e) => setVariations(Math.max(1, +e.target.value))}
            />
          </label>
          <label className="field">
            <span>Size</span>
            <select className="input" value={side} onChange={(e) => setSide(+e.target.value)}>
              {[512, 768, 1024, 1280, 1536].filter((s) => s <= maxSide).map((s) => (
                <option key={s} value={s}>{`${s}×${s}`}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Steps</span>
            <input
              className="input"
              type="number"
              min={1}
              max={maxSteps}
              value={steps}
              onChange={(e) => setSteps(+e.target.value)}
            />
          </label>
          <div className="field">
            <span>Images</span>
            <div className={`input ${total > bulkMax ? "border-red-500 text-red-600" : ""}`}>
              {total} / {bulkMax} max
            </div>
          </div>
        </div>
        <div className="flex gap-3">
          <input
            className="input flex-1"
            type="password"
            placeholder="Access code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="Access code"
            autoComplete="off"
          />
          <button className="btn" disabled={submitting || running || total === 0 || total > bulkMax}>
            {submitting ? "Submitting…" : running ? "Running…" : `Generate ${total}`}
          </button>
        </div>
        <p className="text-xs text-subtle">
          Each image is its own Runpod job, all submitted at once. Runpod&apos;s autoscaler spreads them over the
          endpoint&apos;s workers (max workers caps the parallelism); the rest wait in the queue.
        </p>
      </form>

      {problem && (
        <div className="mt-3">
          <Notice tone="error" title="Couldn't start the bulk run">
            {problem}
          </Notice>
        </div>
      )}

      {run && summary && (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Done" value={`${summary.done} / ${run.jobs.length}${summary.failed ? ` (${summary.failed} failed)` : ""}`} />
            <Stat label="Total time" value={secs(summary.wallMs)} />
            <Stat label="GPU time (sum of executions)" value={secs(summary.gpuMs)} />
            <Stat
              label="Speed-up vs one at a time"
              value={summary.speedup ? `${summary.speedup.toFixed(2)}×` : "–"}
              hint="sum of execution times ÷ total time"
            />
            <Stat label="Workers used" value={String(summary.workers.size)} />
            <Stat label="Cold starts" value={String(summary.cold)} />
            <Stat label="Max queue wait" value={secs(summary.maxDelayMs)} />
            <Stat label="Total cost" value={usd(summary.costUsd)} />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {run.jobs.map((j, i) => (
              <JobCard key={j.id ?? `failed-${i}`} job={j} index={i} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function summarize(run: Run | null, now: number) {
  if (!run) return null;
  const views = run.jobs.map((j) => j.view).filter((v): v is JobView => !!v);
  const completed = views.filter((v) => v.status === "COMPLETED" && !v.error);
  const allDone = run.jobs.every(isDone);
  const lastFinish = Math.max(
    run.submittedAt,
    ...views.filter((v) => v.clientWallMs !== undefined).map((v) => v.submittedAt + v.clientWallMs!),
  );
  const wallMs = (allDone ? lastFinish : Math.max(now, lastFinish)) - run.submittedAt;
  const gpuMs = completed.reduce((a, v) => a + (v.executionMs ?? 0), 0);
  return {
    done: run.jobs.filter(isDone).length,
    failed: run.jobs.filter((j) => j.error || !j.id).length,
    wallMs,
    gpuMs,
    // Only meaningful once something finished; >1 means jobs really ran in parallel.
    speedup: completed.length && wallMs > 0 ? gpuMs / wallMs : null,
    workers: new Set(completed.map((v) => v.output?.worker?.id).filter(Boolean)),
    cold: completed.filter((v) => v.output?.worker?.cold_start).length,
    maxDelayMs: views.reduce((m, v) => Math.max(m, v.delayMs ?? 0), 0) || null,
    costUsd: completed.reduce((a, v) => a + (v.costUsd ?? 0), 0),
  };
}

function JobCard({ job, index }: { job: BulkJob; index: number }) {
  const v = job.view;
  const w = v?.output?.worker;
  const status = job.error
    ? "failed"
    : !v
      ? "queued"
      : v.status === "IN_PROGRESS" && v.progress
        ? `step ${v.progress.step}/${v.progress.total_steps}`
        : v.status.replace("_", " ").toLowerCase();
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="relative aspect-square bg-muted">
        {job.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={job.image} alt={job.input.prompt} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center p-2 text-center text-xs text-subtle">
            {job.error ?? status}
          </div>
        )}
        {w?.cold_start && (
          <span className="absolute top-1.5 left-1.5 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-medium text-black">
            cold start
          </span>
        )}
        <span className="absolute top-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
          #{index + 1}
        </span>
      </div>
      <div className="space-y-0.5 p-2 text-[11px]">
        <p className="truncate" title={job.input.prompt}>
          {job.input.prompt}
        </p>
        <p className="flex justify-between text-subtle">
          <span>{w ? shortGpu(w.gpu) : status}</span>
          <span className="font-mono">{v?.executionMs ? secs(v.executionMs) : ""}</span>
        </p>
        <p className="flex justify-between text-subtle">
          <span className="truncate font-mono">{w?.id ?? ""}</span>
          <span className="font-mono">{v?.delayMs !== undefined ? `q ${secs(v.delayMs)}` : ""}</span>
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-muted p-3" title={hint}>
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
}
