"use client";

import { Clapperboard, Download, Gamepad2, Images, Loader2, Volume2, VolumeX, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { TERMINAL, type AnimateInput, type VideoJobView, type VideoModel } from "@/lib/types";

import { getJson, isTransient } from "../api";
import { secs, shortGpu, usd } from "../format";
import WaitingGame from "../fun/WaitingGame";
import Notice from "../Notice";
import { Badge, Button, buttonClass, Segmented } from "../ui/primitives";
import { useToast } from "../ui/Toaster";
import { Term } from "../ui/Tooltip";
import { useAccessCode } from "../useAccessCode";

const MOTION_PRESETS = [
  { label: "Slow push-in", prompt: "Slow cinematic camera push-in toward the product, soft light shifting, gentle depth of field" },
  { label: "Orbit", prompt: "Smooth camera orbit around the product, studio lighting, subtle reflections moving across the surface" },
  { label: "Turntable", prompt: "The product slowly rotates on a turntable, steady camera, clean studio light" },
  { label: "Atmosphere", prompt: "Static camera, light flickers softly, dust particles drift in the air, subtle ambient motion" },
];

const DURATIONS = [
  { frames: 49, label: "2 s" },
  { frames: 121, label: "5 s" },
];

const POLL_MS = 3000;
const MAX_POLL_FAILURES = 40;

export const VIDEO_MODEL_LABELS: Record<VideoModel, { label: string; hint: string }> = {
  wan22: { label: "Fast · Wan 2.2", hint: "48 GB GPUs, usually available; no sound" },
  ltx2: { label: "Best · LTX-2.5", hint: "80 GB GPUs, can queue when supply is low; with sound" },
};

export interface AnimateSource {
  id: string; // library media id (the image job id)
  prompt: string;
  url: string; // something <img> can show
}

/** Modal: animate a library image with the LTX-2.5 endpoint and play the result. */
export default function AnimateDialog({
  source,
  models,
  onClose,
}: {
  source: AnimateSource;
  /** Video models this deployment offers, fastest first. */
  models: VideoModel[];
  onClose: () => void;
}) {
  const [model, setModel] = useState<VideoModel>(models[0] ?? "wan22");
  const [prompt, setPrompt] = useState(MOTION_PRESETS[0].prompt);
  const [resolution, setResolution] = useState<AnimateInput["resolution"]>("540p");
  const [frames, setFrames] = useState(49);
  const [audio, setAudio] = useState(true);
  const { code, setCode, remember } = useAccessCode();
  const [job, setJob] = useState<VideoJobView | null>(null);
  const [problem, setProblem] = useState<{ tone: "warn" | "error"; title: string; detail?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToast();

  const running = !!job && !TERMINAL.includes(job.status);

  useEffect(() => {
    // Closing never cancels the job: the library picks the clip up when it finishes.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const poll = useCallback(
    async function poll(id: string, failures = 0) {
      const res = await getJson<VideoJobView>(`/api/videos/${id}`);
      if (!res.ok) {
        if (isTransient(res.status) && failures < MAX_POLL_FAILURES) {
          setProblem({ tone: "warn", title: "Lost contact with the app server, still trying", detail: res.error });
          timer.current = setTimeout(() => poll(id, failures + 1), POLL_MS);
          return;
        }
        setProblem({ tone: "error", title: "Couldn't get the video status", detail: res.error });
        return;
      }
      const view = res.data;
      setProblem(null);
      setJob(view);
      if (TERMINAL.includes(view.status)) {
        if (view.status === "COMPLETED" && !view.error) toast("success", "Clip ready · saved to the library");
        else
          setProblem({
            tone: "error",
            title: `The video job ${view.status === "COMPLETED" ? "returned an error" : view.status.toLowerCase().replace("_", " ")}`,
            detail: view.error ?? "No error message was returned.",
          });
        return;
      }
      timer.current = setTimeout(() => poll(id), POLL_MS);
    },
    [toast],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    remember(code);
    setProblem(null);
    setSubmitting(true);
    const res = await getJson<{ id: string; status: VideoJobView["status"]; input: AnimateInput }>("/api/animate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-access-code": code },
      body: JSON.stringify({ model, sourceId: source.id, prompt, resolution, num_frames: frames, audio: audio && model === "ltx2" }),
    });
    setSubmitting(false);
    if (!res.ok) {
      setProblem({
        tone: "error",
        title: res.status === 401 ? "Access code not accepted" : res.status === 429 ? "Limit reached" : "Couldn't start the video",
        detail: res.error,
      });
      return;
    }
    setNow(Date.now());
    setJob({ id: res.data.id, status: res.data.status, submittedAt: Date.now(), input: res.data.input });
    poll(res.data.id);
  }

  const elapsed = job ? (job.clientWallMs ?? Math.max(now - job.submittedAt, 0)) : 0;
  const w = job?.output?.worker;
  const done = job?.status === "COMPLETED" && job.output;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Animate image"
      onClick={onClose}
    >
      <div
        className="max-h-full w-full max-w-4xl overflow-auto rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
          <Clapperboard className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">
            <Term term="animate">Animate</Term>
          </h2>
          <Button size="sm" variant="ghost" className="ml-auto" aria-label="Close" icon={<X className="h-4 w-4" />} onClick={onClose} />
        </header>

        <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          {/* Source frame, or the clip once it's ready */}
          <div className="space-y-2">
            <div className="relative overflow-hidden rounded-xl border border-border bg-muted">
              {playing && job ? (
                <WaitingGame
                  statusLine={
                    job.status === "IN_PROGRESS" && job.progress
                      ? `Generating · step ${job.progress.step}/${job.progress.total_steps}`
                      : running
                        ? `Waiting for a video GPU · ${secs(elapsed, 0)}`
                        : "Clip ready"
                  }
                  paused={!running}
                  onDone={!running ? () => setPlaying(false) : undefined}
                  doneLabel={done ? "Your clip is ready" : "The video job finished"}
                />
              ) : done ? (
                <video src={job.output!.url} controls autoPlay loop playsInline className="w-full" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={source.url} alt={source.prompt} className={`w-full ${running ? "opacity-60" : ""}`} />
              )}
              {running && !playing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  {job.status === "IN_PROGRESS" && job.progress
                    ? `Step ${job.progress.step} of ${job.progress.total_steps}`
                    : "Waiting for a video GPU…"}
                  <button
                    type="button"
                    onClick={() => setPlaying(true)}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs hover:bg-black/70"
                  >
                    <Gamepad2 className="h-3.5 w-3.5" /> Play while you wait
                  </button>
                </div>
              )}
            </div>
            <p className="line-clamp-2 text-xs text-subtle">From: {source.prompt}</p>
          </div>

          <div className="space-y-4">
            {!job || (!running && !done) ? (
              <form onSubmit={submit} className="space-y-4">
                <label className="block space-y-1.5">
                  <span className="text-xs text-subtle">
                    <Term term="motionPrompt">Motion prompt</Term>
                  </span>
                  <textarea className="input min-h-20 resize-y" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={1000} aria-label="Motion prompt" />
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {MOTION_PRESETS.map((p) => (
                    <button key={p.label} type="button" className={`chip ${prompt === p.prompt ? "border-accent text-accent" : ""}`} onClick={() => setPrompt(p.prompt)}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {models.length > 1 && (
                  <div className="space-y-1.5">
                    <span className="block text-xs text-subtle"><Term term="videoModel">Model</Term></span>
                    <Segmented
                      label="Video model"
                      value={model}
                      onChange={setModel}
                      options={models.map((m) => ({ value: m, label: VIDEO_MODEL_LABELS[m].label, title: VIDEO_MODEL_LABELS[m].hint }))}
                    />
                    <p className="text-[11px] text-subtle">{VIDEO_MODEL_LABELS[model].hint}</p>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <div className="space-y-1.5">
                    <span className="block text-xs text-subtle"><Term term="duration">Length</Term></span>
                    <Segmented label="Length" value={frames} onChange={setFrames} options={DURATIONS.map((d) => ({ value: d.frames, label: d.label }))} />
                  </div>
                  <div className="space-y-1.5">
                    <span className="block text-xs text-subtle"><Term term="videoResolution">Resolution</Term></span>
                    <Segmented label="Resolution" value={resolution} onChange={setResolution} options={[{ value: "540p", label: "540p" }, { value: "720p", label: "720p" }]} />
                  </div>
                  <div className="space-y-1.5">
                    <span className="block text-xs text-subtle"><Term term="audio">Sound</Term></span>
                    <Segmented
                      label="Sound"
                      value={audio && model === "ltx2" ? "on" : "off"}
                      onChange={(v) => model === "ltx2" && setAudio(v === "on")}
                      options={[
                        { value: "on", label: <><Volume2 className="h-3.5 w-3.5" /> On</> },
                        { value: "off", label: <><VolumeX className="h-3.5 w-3.5" /> Off</> },
                      ]}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <input className="input flex-1" type="password" placeholder="Access code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Access code" autoComplete="off" />
                  <Button type="submit" variant="primary" loading={submitting} disabled={!prompt.trim()} icon={<Clapperboard className="h-4 w-4" />}>
                    Animate
                  </Button>
                </div>
                <p className="text-xs text-subtle">
                  Runs on a separate video GPU endpoint. The first clip after a quiet period includes a{" "}
                  <Term term="videoColdStart">model load</Term> that can take minutes.
                </p>
              </form>
            ) : (
              <div className="space-y-4 text-sm">
                <div className="flex items-center gap-2">
                  <Badge tone={done ? "green" : job.status === "IN_PROGRESS" ? "blue" : "neutral"}>
                    {done ? "Done" : job.status === "IN_PROGRESS" ? "Generating" : "Queued"}
                  </Badge>
                  <span className="font-mono text-xs text-subtle">{secs(elapsed)}</span>
                </div>
                {running && job.status === "IN_QUEUE" && elapsed > 20_000 && (
                  <Notice tone="warn" title="Starting a video GPU">
                    No warm video worker: Runpod is bringing one up and loading the model. This can take several
                    minutes; you can keep this open, or close it and follow the job in the Library.
                  </Notice>
                )}
                {running && job.progress && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-accent transition-all" style={{ width: `${(100 * job.progress.step) / job.progress.total_steps}%` }} />
                  </div>
                )}
                <p className="text-xs text-subtle">“{job.input.prompt}”</p>
                <dl className="grid grid-cols-2 gap-2.5 text-xs">
                  <Fact label={<Term term="queue">Queue + cold start</Term>} value={secs(job.delayMs)} />
                  <Fact label={<Term term="execution">GPU time</Term>} value={secs(job.executionMs)} />
                  <Fact label="GPU" value={shortGpu(w?.gpu)} />
                  <Fact label={<Term term="cost">Cost</Term>} value={usd(job.costUsd)} />
                  <Fact label={<Term term="vram">Peak VRAM</Term>} value={w ? `${w.peak_vram_gb} / ${w.vram_total_gb} GB` : "–"} />
                  <Fact
                    label="Clip"
                    value={job.output ? `${job.output.params.width}×${job.output.params.height} · ${job.output.params.duration_s}s · ${(job.output.bytes / 2 ** 20).toFixed(1)} MB` : `${job.input.resolution} · ${job.input.num_frames} frames`}
                  />
                </dl>
                {done && (
                  <div className="flex flex-wrap gap-2">
                    <a className={buttonClass("primary", "sm")} href={`${job.output!.url}?download`}>
                      <Download className="h-3.5 w-3.5" /> Download MP4
                    </a>
                    <Link href="/library" className={buttonClass("secondary", "sm")}>
                      <Images className="h-3.5 w-3.5" /> Open library
                    </Link>
                    <Button size="sm" variant="ghost" onClick={() => setJob(null)}>
                      Make another
                    </Button>
                  </div>
                )}
              </div>
            )}
            {problem && (
              <Notice tone={problem.tone} title={problem.title}>
                {problem.detail}
              </Notice>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background/50 px-3 py-2">
      <dt className="text-[11px] text-subtle">{label}</dt>
      <dd className="mt-0.5 font-mono text-[12px]">{value}</dd>
    </div>
  );
}
