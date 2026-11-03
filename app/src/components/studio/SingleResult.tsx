"use client";

import { Clapperboard, Copy, Download, Gamepad2, Images, Loader2, RotateCcw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { JobView } from "@/lib/types";

import WaitingGame from "../fun/WaitingGame";
import { secs, shortGpu, usd } from "../format";
import Notice from "../Notice";
import { Badge, Button, buttonClass, EmptyState } from "../ui/primitives";
import { useToast } from "../ui/Toaster";
import { InfoTip, Term } from "../ui/Tooltip";
import type { Problem } from "./useJobs";

const STAGES = [
  { key: "IN_QUEUE", label: "Queued" },
  { key: "IN_PROGRESS", label: "Generating" },
  { key: "COMPLETED", label: "Done" },
] as const;

export default function SingleResult({
  job,
  image,
  problem,
  onReuse,
  onAnimate,
}: {
  job: JobView | null;
  image: string | null;
  problem: Problem | null;
  onReuse: (job: JobView) => void;
  /** Present only when the deployment has a video endpoint. */
  onAnimate?: (job: JobView, image: string) => void;
}) {
  const toast = useToast();
  const [now, setNow] = useState(0);
  // The game stays open after the image arrives until the player chooses to look.
  const [gameFor, setGameFor] = useState<string | null>(null);
  const running = !!job && !["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  if (!job)
    return (
      <>
        {problem && <Notice tone={problem.tone} title={problem.title}>{problem.detail}</Notice>}
        {!problem && (
          <EmptyState icon={<Sparkles className="h-8 w-8" />} title="Your image will appear here">
            Pick a preset or write a prompt, then press Generate. The first request after a quiet period includes a cold
            start while Runpod brings a GPU online.
          </EmptyState>
        )}
      </>
    );

  const elapsed = job.clientWallMs ?? Math.max(now - job.submittedAt, 0);
  const gameOpen = gameFor === job.id;
  const statusLine =
    job.status === "IN_PROGRESS" && job.progress
      ? `Generating · step ${job.progress.step}/${job.progress.total_steps}`
      : job.status === "IN_QUEUE"
        ? `Waiting for a GPU · ${secs(elapsed, 0)}`
        : job.status === "COMPLETED"
          ? "Image ready"
          : job.status.toLowerCase();
  const stage = STAGES.findIndex((s) => s.key === job.status);
  const ratio = job.input.width / job.input.height;
  const progress = job.progress ? job.progress.step / job.progress.total_steps : 0;

  return (
    <div className="space-y-4">
      {problem && <Notice tone={problem.tone} title={problem.title}>{problem.detail}</Notice>}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div>
          <div
            className="relative mx-auto max-h-[70vh] overflow-hidden rounded-xl border border-border bg-muted"
            style={{ aspectRatio: ratio }}
          >
            {gameOpen ? (
              <div className="absolute inset-0 bg-card">
                <WaitingGame
                  statusLine={statusLine}
                  paused={!running}
                  onDone={!running ? () => setGameFor(null) : undefined}
                  doneLabel={job.status === "COMPLETED" ? "Your image is ready" : "The job finished"}
                />
              </div>
            ) : image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt={job.input.prompt} className="h-full w-full object-contain" />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-subtle">
                <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-accent/10 via-transparent to-accent/5" />
                <Loader2 className="relative h-6 w-6 animate-spin text-accent" />
                <span className="relative">
                  {job.status === "IN_PROGRESS" && job.progress
                    ? `Step ${job.progress.step} of ${job.progress.total_steps}`
                    : job.status === "IN_QUEUE"
                      ? "Waiting for a GPU worker…"
                      : job.status.toLowerCase()}
                </span>
                {job.status === "IN_QUEUE" && elapsed > 8000 && (
                  <span className="relative max-w-xs text-center text-xs">
                    No warm worker yet: Runpod is starting one (<Term term="coldStart">cold start</Term>). Usually under a
                    minute; longer if a new host has to download the image.
                  </span>
                )}
                {running && (
                  <button
                    type="button"
                    onClick={() => setGameFor(job.id)}
                    className="relative mt-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground hover:border-accent hover:text-accent"
                  >
                    <Gamepad2 className="h-3.5 w-3.5" /> Play while you wait
                  </button>
                )}
              </div>
            )}
            {running && (
              <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
                <div className="h-full bg-accent transition-all duration-500" style={{ width: `${progress * 100}%` }} />
              </div>
            )}
          </div>
          {image && job.status === "COMPLETED" && (
            <div className="mt-3 flex flex-wrap gap-2">
              {onAnimate && (
                <Button size="sm" variant="primary" icon={<Clapperboard className="h-3.5 w-3.5" />} onClick={() => onAnimate(job, image)}>
                  Animate
                </Button>
              )}
              <a href={image} download={`flux-${job.output?.seed ?? job.id}.jpg`} className={buttonClass("secondary", "sm")}>
                <Download className="h-3.5 w-3.5" /> Download
              </a>
              <Button
                size="sm"
                icon={<Copy className="h-3.5 w-3.5" />}
                onClick={() => {
                  navigator.clipboard?.writeText(String(job.output?.seed ?? "")).then(
                    () => toast("success", `Seed ${job.output?.seed} copied`),
                    () => toast("error", "Couldn't copy to the clipboard"),
                  );
                }}
              >
                Copy seed
              </Button>
              <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => onReuse(job)}>
                Reuse settings
              </Button>
              <Link href="/library" className={buttonClass("ghost", "sm")}>
                <Images className="h-3.5 w-3.5" /> Saved to library
              </Link>
            </div>
          )}
        </div>

        <Inspector job={job} elapsed={elapsed} stage={stage} />
      </div>
    </div>
  );
}

/** Where the time and money went for one request. */
function Inspector({ job, elapsed, stage }: { job: JobView; elapsed: number; stage: number }) {
  const w = job.output?.worker;
  const t = job.output?.timings;
  const done = job.clientWallMs !== undefined && job.delayMs !== undefined && job.executionMs !== undefined;
  const network = done ? Math.max(job.clientWallMs! - job.delayMs! - job.executionMs!, 0) : undefined;
  const inference = t?.inference_ms ?? 0;
  const other = Math.max((job.executionMs ?? 0) - inference, 0); // encode + handler overhead
  const segments = done
    ? [
        { key: "queue", label: w?.cold_start ? "Queue + cold start" : "Queue", ms: job.delayMs!, color: "bg-amber-500" },
        { key: "inference", label: "Inference", ms: inference, color: "bg-accent" },
        { key: "encode", label: "Encode", ms: other, color: "bg-sky-500" },
        { key: "network", label: "Network", ms: network!, color: "bg-zinc-400" },
      ]
    : [];
  const total = segments.reduce((a, s) => a + s.ms, 0) || 1;

  return (
    <div className="space-y-5 text-sm">
      <ol className="flex items-center gap-1.5">
        {STAGES.map((s, i) => {
          const failed = job.status === "FAILED" && i === Math.max(stage, 0);
          const tone = failed ? "red" : i < stage || job.status === "COMPLETED" ? "green" : i === stage ? "blue" : "neutral";
          return (
            <li key={s.key} className="flex items-center gap-1.5">
              <Badge tone={tone}>{failed ? "Failed" : s.label}</Badge>
              {i < STAGES.length - 1 && <span className="text-subtle">→</span>}
            </li>
          );
        })}
        <span className="ml-auto font-mono text-xs text-subtle">{secs(elapsed)}</span>
      </ol>

      <div>
        <div className="mb-2 flex items-center justify-between text-xs text-subtle">
          <span>Where the time went</span>
          <span className="font-mono text-foreground">{done ? secs(job.clientWallMs) : "…"}</span>
        </div>
        <div className="flex h-3 overflow-hidden rounded-full bg-muted">
          {segments.map((s) => (
            <div key={s.key} className={`${s.color} transition-all`} style={{ width: `${(s.ms / total) * 100}%` }} title={`${s.label}: ${secs(s.ms)}`} />
          ))}
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1.5 text-xs">
          <Row color="bg-amber-500" label={<Term term={w?.cold_start ? "coldStart" : "queue"}>{w?.cold_start ? "Queue + cold start" : "Queue"}</Term>} value={secs(job.delayMs)} />
          <Row color="bg-accent" label={<Term term="inference">Inference</Term>} value={secs(t?.inference_ms)} />
          <Row color="bg-sky-500" label={<Term term="encode">Encode + handler</Term>} value={done ? secs(other, 2) : "–"} />
          <Row color="bg-zinc-400" label={<Term term="network">Network + polling</Term>} value={secs(network)} />
        </dl>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Fact label={<Term term="execution">Billed GPU time</Term>} value={secs(job.executionMs)} />
        <Fact label={<Term term="cost">Cost</Term>} value={usd(job.costUsd)} />
        <Fact label="GPU" value={shortGpu(w?.gpu)} />
        <Fact label={<Term term="vram">Peak VRAM</Term>} value={w ? `${w.peak_vram_gb} / ${w.vram_total_gb} GB` : "–"} />
        <Fact
          label={<Term term="coldStart">Worker start</Term>}
          value={w ? (w.cold_start ? <Badge tone="amber">cold · load {secs(w.model_load_ms)}</Badge> : <Badge tone="green">warm · job #{w.jobs_served}</Badge>) : "–"}
        />
        <Fact label={<Term term="seed">Seed</Term>} value={job.output?.seed ?? "–"} />
      </div>
      {w?.id && (
        <p className="flex items-center gap-1 font-mono text-[11px] text-subtle">
          worker {w.id} · job {job.id.slice(0, 13)}… <InfoTip term="workers" />
        </p>
      )}
    </div>
  );
}

function Row({ color, label, value }: { color: string; label: React.ReactNode; value: string }) {
  return (
    <>
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <dt className="text-subtle">{label}</dt>
      <dd className="text-right font-mono">{value}</dd>
    </>
  );
}

function Fact({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background/50 px-3 py-2">
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="mt-0.5 font-mono text-[13px]">{value}</div>
    </div>
  );
}
