"use client";

import { Bot, Flag, History, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import type { Budget, Contestant, PersonaId, RunSummary } from "@/lib/agentTypes";

import { getJson } from "../api";
import { ago, usd } from "../format";
import Notice from "../Notice";
import { Card, EmptyState, Segmented, Skeleton } from "../ui/primitives";
import { Term } from "../ui/Tooltip";
import { useAccessCode } from "../useAccessCode";
import RunTrace from "./RunTrace";
import { BudgetFields, MediaGrid, ModelSelect, RunBar, SpendMeter, StatusBadge, useAgentsConfig, usePost, useRun } from "./shared";

export const EXAMPLE_BRIEFS = [
  "Hero image for a small Lisbon bakery's Instagram launch: a pastel de nata on blue azulejo tiles, warm morning light.",
  "Three cover options for a sci-fi podcast episode about life under the ice of Europa; pick the strongest and turn it into a 2 s loop.",
  "A cosy-game style poster of a lighthouse keeper's cat. Make it as cheap as you can.",
];

/** Remembers the run being watched in the URL, so a reload resumes it. */
export function useRunParam(name = "run") {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setId(new URLSearchParams(window.location.search).get(name)), 0);
    return () => clearTimeout(t);
  }, [name]);
  const set = (v: string | null) => {
    setId(v);
    const url = new URL(window.location.href);
    if (v) url.searchParams.set(name, v);
    else url.searchParams.delete(name);
    window.history.replaceState(null, "", url);
  };
  return [id, set] as const;
}

export function useRecentRuns(kind: "agent" | "pipeline", refreshKey: unknown) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    getJson<{ runs: RunSummary[] }>("/api/runs").then((r) => {
      if (alive && r.ok) setRuns(r.data.runs.filter((x) => x.kind === kind && !x.battleId));
    });
    return () => {
      alive = false;
    };
  }, [kind, refreshKey]);
  return runs;
}

export function RecentRunList({ runs, current, onPick }: { runs: RunSummary[] | null; current: string | null; onPick: (id: string) => void }) {
  if (!runs?.length) return <p className="text-xs text-subtle">No runs yet.</p>;
  return (
    <ul className="divide-y divide-border">
      {runs.slice(0, 8).map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onPick(r.id)} className={`flex w-full items-center gap-2 py-2 text-left text-xs hover:text-accent ${r.id === current ? "text-accent" : ""}`}>
            <StatusBadge status={r.status} />
            <span className="min-w-0 flex-1 truncate">{r.brief || r.title}</span>
            {r.mock && <span className="text-[10px] text-subtle">dry</span>}
            <span className="font-mono text-subtle">{usd(r.spend.gpuUsd + r.spend.llmUsd)}</span>
            <span className="w-14 text-right text-subtle">{ago(r.createdAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function AgentPlayground() {
  const { cfg, error: cfgError } = useAgentsConfig();
  const { code, setCode, remember } = useAccessCode();
  const post = usePost();
  const [brief, setBrief] = useState(EXAMPLE_BRIEFS[0]);
  const [pick, setPick] = useState<Omit<Contestant, "persona"> | null>(null);
  const [persona, setPersona] = useState<PersonaId>("balanced");
  const [budget, setBudget] = useState<Budget | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runId, setRunId] = useRunParam();
  const { run, error: runError } = useRun(runId);
  const recent = useRecentRuns("agent", run?.status);

  const model = cfg?.models.find((m) => m.provider === pick?.provider && m.model === pick?.model) ?? cfg?.models[0];
  const b = budget ?? cfg?.defaultBudget;

  const start = async () => {
    if (!model || !b) return;
    setStarting(true);
    remember(code);
    const res = await post<{ id: string }>("/api/agents/run", code, {
      brief,
      contestant: { provider: model.provider, model: model.model, persona },
      budget: b,
      dryRun,
    });
    setStarting(false);
    if (res) setRunId(res.id);
  };

  const stop = () => runId && post(`/api/runs/${runId}/stop`, code);
  const running = run?.status === "running";

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Bot className="h-6 w-6 text-accent" /> Agent playground
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-subtle">
          Give an <Term term="agent">agent</Term> a brief and a <Term term="budget">budget</Term>. It plans, makes{" "}
          <Term term="toolCall">tool calls</Term> that start real GPU jobs on the Runpod endpoints, inspects what comes back and delivers. Every
          step, token and cent is shown.
        </p>
      </header>

      {cfgError && <Notice tone="error" title="Couldn't load the agent configuration">{cfgError}</Notice>}
      {cfg?.mock && (
        <Notice tone="warn" title="Dry-run only">
          No GPU endpoint is configured on this server, so tools return placeholder images.
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-6">
          <Card title="Brief">
            <div className="space-y-4">
              <textarea className="input min-h-28" value={brief} onChange={(e) => setBrief(e.target.value)} aria-label="Brief" maxLength={2000} />
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLE_BRIEFS.map((x, i) => (
                  <button key={i} type="button" className="chip" onClick={() => setBrief(x)}>
                    Example {i + 1}
                  </button>
                ))}
              </div>
              {!cfg ? (
                <Skeleton className="h-40" />
              ) : (
                <>
                  <label className="block">
                    <span className="mb-1.5 block text-xs text-subtle">Model</span>
                    <ModelSelect models={cfg.models} value={model!} onChange={(m) => setPick({ provider: m.provider, model: m.model })} label="Model" />
                  </label>
                  <div>
                    <span className="mb-1.5 block text-xs text-subtle">
                      <Term term="persona">Persona</Term>
                    </span>
                    <Segmented
                      label="Persona"
                      value={persona}
                      onChange={setPersona}
                      options={cfg.personas.map((p) => ({ value: p.id, label: p.label, title: p.description }))}
                    />
                  </div>
                  <div>
                    <span className="mb-1.5 block text-xs text-subtle">
                      <Term term="budget">Budget</Term>
                    </span>
                    <BudgetFields value={b!} max={cfg.maxBudget} onChange={setBudget} />
                  </div>
                  <RunBar
                    code={code}
                    setCode={setCode}
                    dryRun={dryRun}
                    setDryRun={setDryRun}
                    forcedDryRun={cfg.mock}
                    running={running}
                    starting={starting}
                    onStart={start}
                    onStop={stop}
                    startLabel="Run agent"
                  />
                </>
              )}
            </div>
          </Card>

          <Card title={<span className="flex items-center gap-2"><Wrench className="h-4 w-4" /> Tools</span>}>
            {!cfg ? (
              <Skeleton className="h-24" />
            ) : (
              <ul className="space-y-2 text-xs">
                {cfg.tools
                  .filter((t) => !t.vision || model?.vision)
                  .filter((t) => t.name !== "animate_image" || cfg.videoEnabled || dryRun || cfg.mock)
                  .map((t) => (
                    <li key={t.name}>
                      <code className="font-semibold">{t.name}</code> <span className="text-subtle">{t.description}</span>
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          <Card title={<span className="flex items-center gap-2"><History className="h-4 w-4" /> Recent runs</span>}>
            <RecentRunList runs={recent} current={runId} onPick={setRunId} />
          </Card>
        </div>

        <div className="space-y-6">
          {!run && !runId && (
            <EmptyState icon={<Bot className="h-8 w-8" />} title="No run yet">
              Start with a dry run to see the agent loop without using a GPU. Then switch it off for real images.
            </EmptyState>
          )}
          {runId && !run && !runError && <Skeleton className="h-96" />}
          {runError && <Notice tone="warn" title="Run status">{runError}</Notice>}
          {run && (
            <>
              {run.status !== "running" && run.result && (
                <Card
                  title={
                    <span className="flex items-center gap-2">
                      <Flag className="h-4 w-4 text-accent" /> Delivery
                    </span>
                  }
                  actions={<StatusBadge status={run.status} />}
                >
                  <div className="space-y-3">
                    {run.error && <Notice tone="warn" title="Note">{run.error}</Notice>}
                    <p className="text-sm whitespace-pre-wrap">{run.result.text}</p>
                    <MediaGrid ids={run.result.mediaIds} media={run.media} />
                  </div>
                </Card>
              )}
              <Card
                title={
                  <span className="flex items-center gap-2">
                    Trace <span className="font-normal text-subtle">· {run.title}</span>
                    {run.mock && <span className="text-[11px] font-normal text-amber-600">dry run</span>}
                  </span>
                }
                actions={<StatusBadge status={run.status} />}
              >
                <div className="space-y-4">
                  <SpendMeter run={run} />
                  <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs">
                    <span className="text-subtle">Brief:</span> {run.brief}
                  </p>
                  <div className="max-h-[70vh] overflow-y-auto pr-1">
                    <RunTrace run={run} />
                  </div>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
