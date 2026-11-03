"use client";

import { useEffect, useRef, useState } from "react";

import { TERMINAL, type GenerateInput, type JobView } from "@/lib/types";

import { getJson } from "./api";
import JobDetails from "./JobDetails";

const PRESETS = [
  "A studio product photo of a ceramic coffee mug on a walnut table, soft morning light, shallow depth of field",
  "A pair of white running shoes on a concrete plinth, hard rim light, minimalist product shot",
  "A glass bottle of olive oil beside fresh rosemary on linen, overhead flat lay, natural light",
  "A leather backpack hanging on a wooden peg against a sage green wall, catalogue photo",
];

const CODE_KEY = "flux-demo-access-code";
// Keep polling through short outages (pod restart, proxy hiccup) for about a minute.
const MAX_POLL_FAILURES = 60;

export default function GeneratePanel({ maxSide, maxSteps, onFinished }: {
  maxSide: number;
  maxSteps: number;
  onFinished: () => void;
}) {
  const [form, setForm] = useState<GenerateInput & { seed?: number }>({
    prompt: PRESETS[0],
    width: 1024,
    height: 1024,
    num_inference_steps: 28,
    guidance_scale: 3.5,
  });
  const [seedText, setSeedText] = useState("");
  const [code, setCode] = useState("");
  const [job, setJob] = useState<JobView | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Restore a remembered access code after hydration (localStorage is browser-only).
    const restore = setTimeout(() => {
      try {
        setCode(localStorage.getItem(CODE_KEY) ?? "");
      } catch {}
    }, 0);
    return () => {
      clearTimeout(restore);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function poll(id: string, failures = 0) {
    let res: Awaited<ReturnType<typeof getJson<JobView & { error?: string }>>>;
    try {
      res = await getJson<JobView & { error?: string }>(`/api/jobs/${id}`);
    } catch {
      res = { ok: false, status: 0, data: { error: "Network error. Retrying…" } as JobView & { error?: string } };
    }
    const view = res.data;
    if (!res.ok) {
      const transient = res.status === 0 || res.status >= 500;
      if (transient && failures < MAX_POLL_FAILURES) {
        setError(view.error ?? `HTTP ${res.status}. Retrying…`);
        timer.current = setTimeout(() => poll(id, failures + 1), 1000);
        return;
      }
      setError(view.error ?? `HTTP ${res.status}`);
      setBusy(false);
      return;
    }
    setError(null);
    setJob(view);
    if (view.output?.image) setImage(view.output.image);
    if (TERMINAL.includes(view.status)) {
      setBusy(false);
      if (view.error) setError(view.error);
      onFinished();
    } else {
      timer.current = setTimeout(() => poll(id), 1000);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setImage(null);
    setJob(null);
    setBusy(true);
    try {
      localStorage.setItem(CODE_KEY, code);
    } catch {}
    const body = { ...form, seed: seedText === "" ? undefined : Number(seedText) };
    const res = await getJson<{ id: string; status: JobView["status"]; input: GenerateInput; error?: string }>(
      "/api/generate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-access-code": code },
        body: JSON.stringify(body),
      },
    ).catch(() => ({ ok: false, status: 0, data: { error: "Network error. Please try again." } as never }));
    const data = res.data;
    if (!res.ok) {
      setError(data.error ?? `HTTP ${res.status}`);
      setBusy(false);
      return;
    }
    setJob({ id: data.id, status: data.status, submittedAt: Date.now(), input: data.input });
    poll(data.id);
  }

  const sideOptions = [512, 768, 1024, 1280, 1536].filter((s) => s <= maxSide);
  const set = <K extends keyof GenerateInput>(k: K, v: GenerateInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <section className="card">
      <h2 className="card-title">Generate</h2>
      <form onSubmit={submit} className="space-y-3">
        <textarea
          className="input h-24 resize-none"
          value={form.prompt}
          maxLength={1000}
          onChange={(e) => set("prompt", e.target.value)}
          aria-label="Prompt"
        />
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p, i) => (
            <button key={i} type="button" className="chip" onClick={() => set("prompt", p)}>
              {p.split(",")[0].replace("A studio product photo of a ", "").replace(/^An? /, "")}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="field">
            <span>Size</span>
            <select
              className="input"
              value={form.width}
              onChange={(e) => setForm((f) => ({ ...f, width: +e.target.value, height: +e.target.value }))}
            >
              {sideOptions.map((s) => (
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
              value={form.num_inference_steps}
              onChange={(e) => set("num_inference_steps", +e.target.value)}
            />
          </label>
          <label className="field">
            <span>Guidance</span>
            <input
              className="input"
              type="number"
              step={0.5}
              min={0}
              max={20}
              value={form.guidance_scale}
              onChange={(e) => set("guidance_scale", +e.target.value)}
            />
          </label>
          <label className="field">
            <span>Seed</span>
            <input
              className="input"
              placeholder="random"
              inputMode="numeric"
              value={seedText}
              onChange={(e) => setSeedText(e.target.value.replace(/\D/g, ""))}
            />
          </label>
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
          <button className="btn" disabled={busy || !form.prompt.trim()}>
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 rounded-md bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {job && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="aspect-square overflow-hidden rounded-lg border border-border bg-muted">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt={job.input.prompt} className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-subtle">
                {job.status === "IN_PROGRESS" && job.progress
                  ? `Step ${job.progress.step}/${job.progress.total_steps}`
                  : job.status === "IN_QUEUE"
                    ? "Waiting for a worker…"
                    : job.status}
              </div>
            )}
          </div>
          <JobDetails job={job} />
        </div>
      )}
    </section>
  );
}
