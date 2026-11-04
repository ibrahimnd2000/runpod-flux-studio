"use client";

import { FlaskConical, ImageOff, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentsConfigView, Budget, ModelOption, RunPollView, RunStatus, RunView } from "@/lib/agentTypes";

import { getJson } from "../api";
import { usd } from "../format";
import { Badge, Button } from "../ui/primitives";
import { Term } from "../ui/Tooltip";
import { useToast } from "../ui/Toaster";

// Building blocks shared by the Pipelines, Agent and Battleground pages.

export function useAgentsConfig() {
  const [cfg, setCfg] = useState<AgentsConfigView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await getJson<AgentsConfigView>("/api/agents/config");
      if (!alive) return;
      if (res.ok) {
        setCfg(res.data);
        setError(null);
      } else {
        setError(res.error ?? "Couldn't load the configuration.");
        setTimeout(load, 10_000);
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, []);
  return { cfg, error };
}

/** Polls a run, fetching only new events each time, until it finishes. */
export function useRun(id: string | null) {
  const [run, setRun] = useState<RunPollView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(-1);

  useEffect(() => {
    seq.current = -1;
    const reset = setTimeout(() => setRun(null), 0);
    if (!id) return () => clearTimeout(reset);
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const res = await getJson<RunPollView>(`/api/runs/${id}?after=${seq.current}`);
      if (!alive) return;
      if (res.ok) {
        setError(null);
        const fresh = res.data;
        if (fresh.events.length) seq.current = fresh.events[fresh.events.length - 1].seq;
        setRun((prev) =>
          prev && prev.id === fresh.id
            ? { ...fresh, events: [...prev.events, ...fresh.events], media: { ...prev.media, ...fresh.media } }
            : fresh,
        );
        if (fresh.status !== "running") return;
      } else {
        setError(res.error ?? "Lost contact with the run.");
        if (res.status === 404) return;
      }
      timer = setTimeout(poll, 1500);
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(reset);
      clearTimeout(timer);
    };
  }, [id]);

  return { run, error };
}

export const statusTone = (s?: RunStatus | "judging") =>
  s === "done" ? "green" : s === "failed" ? "red" : s === "stopped" ? "amber" : "blue";

export function StatusBadge({ status }: { status?: RunStatus | "judging" }) {
  if (!status) return null;
  return (
    <Badge tone={statusTone(status)}>
      {(status === "running" || status === "judging") && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {status}
    </Badge>
  );
}

/** Current time, ticking every second while `live` (for elapsed-time displays). */
export function useNow(live: boolean) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = live ? setInterval(tick, 1000) : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [live]);
  return now;
}

export const elapsedS = (run: RunView, now: number) => Math.max(((run.finishedAt ?? now) - run.createdAt) / 1000, 0);

/** Spend against the run's budget: dollars (GPU vs LLM), images, clips, turns. */
export function SpendMeter({ run, compact = false }: { run: RunView; compact?: boolean }) {
  const { spend: s, budget: b } = run;
  const now = useNow(run.status === "running");
  const total = s.gpuUsd + s.llmUsd;
  const pct = (v: number, max: number) => `${Math.min((v / Math.max(max, 1e-9)) * 100, 100)}%`;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-xs">
        <Term term="budget">
          <span className="font-medium">
            {usd(total)} <span className="text-subtle">of ${b.maxUsd.toFixed(2)}</span>
          </span>
        </Term>
        <span className="font-mono text-subtle">{elapsedS(run, now).toFixed(0)} s</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`Spent ${usd(total)} of $${b.maxUsd}`}>
        <div className="bg-accent transition-all" style={{ width: pct(s.gpuUsd, b.maxUsd) }} title={`GPU ${usd(s.gpuUsd)}`} />
        <div className="bg-amber-500 transition-all" style={{ width: pct(s.llmUsd, b.maxUsd) }} title={`LLM ${usd(s.llmUsd)}`} />
      </div>
      {!compact && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-subtle">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent" />
            GPU {usd(s.gpuUsd)}
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />
            <Term term="llmCost">
              LLM {usd(s.llmUsd)}
              {s.llmEstimatedUsd > 0 ? " est." : ""}
            </Term>
          </span>
          <span>
            {s.images}/{b.maxImages} images
          </span>
          <span>
            {s.videos}/{b.maxVideos} clips
          </span>
          {run.kind === "agent" && (
            <span>
              {s.turns}/{b.maxTurns} turns · {s.toolCalls} tool calls
            </span>
          )}
          {s.inputTokens + s.outputTokens > 0 && (
            <span>
              {(s.inputTokens / 1000).toFixed(1)}k in / {(s.outputTokens / 1000).toFixed(1)}k out tokens
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function MediaThumb({ id, kind, prompt, className = "" }: { id: string; kind?: "image" | "video"; prompt?: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  const cls = `aspect-square w-full rounded-lg border border-border bg-muted object-cover ${className}`;
  if (broken)
    return (
      <div className={`${cls} flex items-center justify-center text-subtle`} title="Deleted from the library">
        <ImageOff className="h-5 w-5" />
      </div>
    );
  return (
    <a href={`/api/media/${id}`} target="_blank" rel="noreferrer" title={prompt} className="block">
      {kind === "video" ? (
        <video src={`/api/media/${id}`} className={cls} autoPlay loop muted playsInline onError={() => setBroken(true)} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/media/${id}`} alt={prompt ?? ""} className={cls} loading="lazy" onError={() => setBroken(true)} />
      )}
    </a>
  );
}

export function MediaGrid({ ids, media, cols = "grid-cols-2 sm:grid-cols-4" }: { ids: string[]; media: RunPollView["media"]; cols?: string }) {
  if (!ids.length) return null;
  return (
    <div className={`grid gap-2 ${cols}`}>
      {ids.map((id) => (
        <MediaThumb key={id} id={id} kind={media[id]?.kind} prompt={media[id]?.prompt} />
      ))}
    </div>
  );
}

export function ModelSelect({
  models,
  value,
  onChange,
  label,
}: {
  models: ModelOption[];
  value: { provider: string; model: string };
  onChange: (m: ModelOption) => void;
  label: string;
}) {
  const key = (m: { provider: string; model: string }) => `${m.provider}|${m.model}`;
  return (
    <select
      className="input"
      aria-label={label}
      value={key(value)}
      onChange={(e) => {
        const m = models.find((x) => key(x) === e.target.value);
        if (m) onChange(m);
      }}
    >
      {models.map((m) => (
        <option key={key(m)} value={key(m)}>
          {m.label}
          {m.vision ? " · sees images" : ""}
        </option>
      ))}
    </select>
  );
}

export function BudgetFields({ value, max, onChange, showTurns = true }: { value: Budget; max: Budget; onChange: (b: Budget) => void; showTurns?: boolean }) {
  const field = (k: keyof Budget, label: string, step: number) => (
    <label className="block">
      <span className="mb-1 block text-[11px] text-subtle">{label}</span>
      <input
        className="input w-full min-w-0 py-1.5 font-mono"
        type="number"
        min={k === "maxUsd" ? 0.01 : 0}
        max={max[k]}
        step={step}
        value={value[k]}
        onChange={(e) => onChange({ ...value, [k]: Math.min(Number(e.target.value), max[k]) })}
      />
    </label>
  );
  return (
    <div className={`grid gap-2 ${showTurns ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
      {field("maxUsd", "Max $", 0.05)}
      {field("maxImages", "Images", 1)}
      {field("maxVideos", "Clips", 1)}
      {showTurns && field("maxTurns", "Turns", 1)}
    </div>
  );
}

/** Access code, dry-run switch and the start / stop button. */
export function RunBar({
  code,
  setCode,
  dryRun,
  setDryRun,
  forcedDryRun,
  running,
  starting,
  onStart,
  onStop,
  startLabel,
  estimate,
}: {
  code: string;
  setCode: (v: string) => void;
  dryRun: boolean;
  setDryRun: (v: boolean) => void;
  forcedDryRun: boolean;
  running: boolean;
  starting: boolean;
  onStart: () => void;
  onStop?: () => void;
  startLabel: string;
  estimate?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        className="input h-9 w-40 py-1"
        type="password"
        placeholder="Access code"
        aria-label="Access code"
        autoComplete="off"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <label className={`inline-flex items-center gap-2 text-xs ${forcedDryRun ? "opacity-60" : ""}`}>
        <input type="checkbox" checked={dryRun || forcedDryRun} disabled={forcedDryRun} onChange={(e) => setDryRun(e.target.checked)} className="accent-[var(--accent)]" />
        <FlaskConical className="h-3.5 w-3.5 text-subtle" />
        <Term term="dryRun">Dry run</Term>
      </label>
      {estimate && <span className="text-xs text-subtle">{estimate}</span>}
      <div className="ml-auto flex gap-2">
        {running && onStop && (
          <Button variant="secondary" icon={<Square className="h-3.5 w-3.5" />} onClick={onStop}>
            Stop
          </Button>
        )}
        <Button variant="primary" loading={starting} disabled={running} icon={<Play className="h-4 w-4" />} onClick={onStart}>
          {startLabel}
        </Button>
      </div>
    </div>
  );
}

/** POSTs with the access code; toasts errors. Returns the JSON body or null. */
export function usePost() {
  const toast = useToast();
  return useCallback(
    async <T,>(url: string, code: string, body?: unknown): Promise<T | null> => {
      const res = await getJson<T>(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-access-code": code },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        toast("error", res.error ?? "Request failed.");
        return null;
      }
      return res.data;
    },
    [toast],
  );
}
