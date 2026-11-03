"use client";

import { ArrowDown, ArrowUp, Braces, Clapperboard, Crown, History, ImageIcon, Images, MessageSquareText, Plus, Trash2, Workflow } from "lucide-react";
import { useMemo, useState } from "react";

import type { Budget, PipelineSpec, PipelineStep, RunEvent, RunPollView, StepState, StepType } from "@/lib/agentTypes";

import { secs, usd } from "../format";
import Notice from "../Notice";
import { Badge, Button, Card, EmptyState, Segmented, Skeleton } from "../ui/primitives";
import { Term } from "../ui/Tooltip";
import { useAccessCode } from "../useAccessCode";
import { RecentRunList, useRecentRuns, useRunParam } from "./AgentPlayground";
import { BudgetFields, MediaGrid, ModelSelect, RunBar, SpendMeter, StatusBadge, useAgentsConfig, usePost, useRun } from "./shared";

const TYPE_META: Record<StepType, { label: string; icon: typeof Workflow; hint: string }> = {
  llm: { label: "LLM", icon: MessageSquareText, hint: "Write text, or a list of prompts" },
  image: { label: "Image", icon: ImageIcon, hint: "Render one FLUX image" },
  images: { label: "Fan-out", icon: Images, hint: "One image per item of a list, in parallel" },
  pick: { label: "Pick", icon: Crown, hint: "An LLM chooses the best image" },
  animate: { label: "Animate", icon: Clapperboard, hint: "Turn an image into a clip" },
};

const STATE_STYLE: Record<StepState, string> = {
  waiting: "border-border bg-card",
  running: "border-accent bg-accent/5 ring-2 ring-accent/30",
  done: "border-emerald-500/60 bg-emerald-500/5",
  failed: "border-red-500/60 bg-red-500/5",
  skipped: "border-border bg-muted opacity-60",
};

/** Same rule as the server: `from` plus every {{steps.x}} in the prompt. */
function deps(step: PipelineStep): string[] {
  const refs = [...(step.prompt ?? "").matchAll(/\{\{\s*steps\.([a-z0-9_]+)/g)].map((m) => m[1]);
  return [...new Set([...(step.from ? [step.from] : []), ...refs])];
}

type StepEvent = Extract<RunEvent, { type: "step" }>;

function latestSteps(run: RunPollView | null): Map<string, StepEvent> {
  const m = new Map<string, StepEvent>();
  for (const e of run?.events ?? []) if (e.type === "step") m.set(e.stepId, e);
  return m;
}

// ------------------------------- DAG view --------------------------------- //
const W = 220;
const H = 70;
const GX = 56;
const GY = 18;

function Graph({ spec, states }: { spec: PipelineSpec; states: Map<string, StepEvent> }) {
  const layout = useMemo(() => {
    const level = new Map<string, number>();
    for (const s of spec.steps) level.set(s.id, Math.max(0, ...deps(s).map((d) => (level.get(d) ?? 0) + 1)));
    const perLevel = new Map<number, number>();
    const pos = new Map<string, { x: number; y: number }>();
    for (const s of spec.steps) {
      const l = level.get(s.id)!;
      const row = perLevel.get(l) ?? 0;
      perLevel.set(l, row + 1);
      pos.set(s.id, { x: l * (W + GX), y: row * (H + GY) });
    }
    const width = (Math.max(...level.values()) + 1) * (W + GX) - GX;
    const height = Math.max(...perLevel.values()) * (H + GY) - GY;
    return { pos, width, height };
  }, [spec]);

  return (
    <div className="overflow-x-auto pb-2">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg className="absolute inset-0 overflow-visible" width={layout.width} height={layout.height} aria-hidden>
          {spec.steps.flatMap((s) =>
            deps(s).map((d) => {
              const a = layout.pos.get(d);
              const b = layout.pos.get(s.id);
              if (!a || !b) return null;
              const x1 = a.x + W;
              const y1 = a.y + H / 2;
              const x2 = b.x;
              const y2 = b.y + H / 2;
              const active = states.get(s.id)?.state === "running";
              return (
                <path
                  key={`${d}-${s.id}`}
                  d={`M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`}
                  fill="none"
                  strokeWidth={active ? 2.5 : 1.5}
                  className={active ? "stroke-accent [stroke-dasharray:6_4] animate-[dash_0.8s_linear_infinite]" : "stroke-border"}
                />
              );
            }),
          )}
        </svg>
        {spec.steps.map((s) => {
          const p = layout.pos.get(s.id)!;
          const ev = states.get(s.id);
          const state = ev?.state ?? "waiting";
          const Icon = TYPE_META[s.type].icon;
          return (
            <div
              key={s.id}
              className={`absolute flex flex-col justify-center rounded-xl border px-3 transition-all ${STATE_STYLE[state]}`}
              style={{ left: p.x, top: p.y, width: W, height: H }}
              title={ev?.summary}
            >
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Icon className={`h-3.5 w-3.5 shrink-0 ${state === "running" ? "animate-pulse text-accent" : "text-subtle"}`} />
                <span className="truncate">{s.title}</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] whitespace-nowrap text-subtle">
                <code>{s.id}</code>
                <span>· {TYPE_META[s.type].label}</span>
                {s.type === "llm" && s.list && <span>· list ×{s.count}</span>}
                <span className="ml-auto font-mono">
                  {ev?.ms !== undefined ? secs(ev.ms) : state}
                  {ev?.costUsd ? ` · ${usd(ev.costUsd)}` : ""}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------ step editor ------------------------------- //
function StepEditor({
  step,
  index,
  steps,
  onChange,
  onMove,
  onDelete,
}: {
  step: PipelineStep;
  index: number;
  steps: PipelineStep[];
  onChange: (s: PipelineStep) => void;
  onMove: (d: -1 | 1) => void;
  onDelete: () => void;
}) {
  const earlier = steps.slice(0, index);
  const fromChoices = earlier.filter((s) =>
    step.type === "images" ? s.type === "llm" && s.list : step.type === "pick" ? s.type === "images" : ["image", "images", "pick"].includes(s.type),
  );
  const set = (patch: Partial<PipelineStep>) => onChange({ ...step, ...patch });
  const Icon = TYPE_META[step.type].icon;
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-4 w-4 text-accent" />
        <input className="input h-8 w-28 py-1 font-mono text-xs" value={step.id} onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })} aria-label="Step id" />
        <input className="input h-8 min-w-0 flex-1 py-1 text-xs" value={step.title} onChange={(e) => set({ title: e.target.value })} aria-label="Step title" />
        <select className="input h-8 w-28 py-1 text-xs" value={step.type} onChange={(e) => set({ type: e.target.value as StepType, from: undefined })} aria-label="Step type">
          {(Object.keys(TYPE_META) as StepType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_META[t].label}
            </option>
          ))}
        </select>
        <div className="flex">
          <Button size="sm" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} icon={<ArrowUp className="h-3.5 w-3.5" />} />
          <Button size="sm" variant="ghost" aria-label="Move down" disabled={index === steps.length - 1} onClick={() => onMove(1)} icon={<ArrowDown className="h-3.5 w-3.5" />} />
          <Button size="sm" variant="ghost" aria-label="Delete step" onClick={onDelete} icon={<Trash2 className="h-3.5 w-3.5" />} />
        </div>
      </div>
      <p className="mt-1.5 text-[11px] text-subtle">{TYPE_META[step.type].hint}</p>
      {(step.type === "images" || step.type === "pick" || step.type === "animate") && (
        <label className="mt-2 flex items-center gap-2 text-xs">
          <span className="w-16 text-subtle">from</span>
          <select className="input h-8 py-1 text-xs" value={step.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })}>
            <option value="">choose a step…</option>
            {fromChoices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} ({TYPE_META[s.type].label})
              </option>
            ))}
          </select>
        </label>
      )}
      <textarea
        className="input mt-2 min-h-16 font-mono text-xs"
        value={step.prompt ?? ""}
        onChange={(e) => set({ prompt: e.target.value })}
        placeholder={step.type === "pick" ? "Criteria: which image is best for…" : step.type === "animate" ? "Motion: slow push-in…" : step.type === "images" ? "{{item}}" : "Prompt"}
        aria-label="Prompt"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        {step.type === "llm" && (
          <>
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" className="accent-[var(--accent)]" checked={!!step.list} onChange={(e) => set({ list: e.target.checked, count: step.count ?? 3 })} />
              returns a list
            </label>
            {step.list && (
              <Segmented label="List length" value={step.count ?? 3} onChange={(v) => set({ count: v })} options={[1, 2, 3, 4].map((n) => ({ value: n, label: `×${n}` }))} />
            )}
          </>
        )}
        {(step.type === "image" || step.type === "images") && (
          <Segmented
            label="Aspect"
            value={step.width && step.height && step.width > step.height ? "landscape" : step.width && step.height && step.width < step.height ? "portrait" : "square"}
            onChange={(v) => set(v === "landscape" ? { width: 1024, height: 768 } : v === "portrait" ? { width: 768, height: 1024 } : { width: 1024, height: 1024 })}
            options={[
              { value: "square", label: "1:1" },
              { value: "landscape", label: "4:3" },
              { value: "portrait", label: "3:4" },
            ]}
          />
        )}
        {step.type === "animate" && (
          <Segmented label="Clip length" value={step.seconds ?? 2} onChange={(v) => set({ seconds: v })} options={[2, 3, 5].map((n) => ({ value: n as 2 | 3 | 5, label: `${n} s` }))} />
        )}
      </div>
    </div>
  );
}

// ------------------------------- the page --------------------------------- //
function estimate(spec: PipelineSpec, prices: { imageUsd: number; videoUsdPerS: number }) {
  let images = 0;
  let videoS = 0;
  for (const s of spec.steps) {
    if (s.type === "image") images += 1;
    if (s.type === "images") images += spec.steps.find((x) => x.id === s.from)?.count ?? 0;
    if (s.type === "animate") videoS += s.seconds ?? 2;
  }
  return { images, videoS, usd: images * prices.imageUsd + videoS * prices.videoUsdPerS };
}

export default function PipelineBuilder() {
  const { cfg, error: cfgError } = useAgentsConfig();
  const { code, setCode, remember } = useAccessCode();
  const post = usePost();
  const [edited, setEdited] = useState<PipelineSpec | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [budget, setBudget] = useState<Budget | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [runId, setRunId] = useRunParam();
  const { run, error: runError } = useRun(runId);
  const recent = useRecentRuns("pipeline", run?.status);

  const spec = edited ?? cfg?.templates[0] ?? null;
  const b = budget ?? (cfg ? { ...cfg.defaultBudget, maxUsd: Math.min(0.5, cfg.maxBudget.maxUsd) } : null);
  const viewing = run?.pipeline && run.status !== "running" && runId ? run.pipeline : null;
  const shown = run?.status === "running" && run.pipeline ? run.pipeline : (viewing ?? spec);
  const states = latestSteps(run?.pipeline && shown === run.pipeline ? run : null);
  const est = spec && cfg ? estimate(spec, cfg.prices) : null;

  const setSpec = (s: PipelineSpec) => setEdited(s);
  const loadTemplate = (id: string) => {
    const t = cfg?.templates.find((x) => x.id === id);
    if (t) {
      setEdited(structuredClone(t));
      setInputs({});
    }
  };
  const updateStep = (i: number, s: PipelineStep) => spec && setSpec({ ...spec, steps: spec.steps.map((x, j) => (j === i ? s : x)) });
  const moveStep = (i: number, d: -1 | 1) => {
    if (!spec) return;
    const steps = [...spec.steps];
    [steps[i], steps[i + d]] = [steps[i + d], steps[i]];
    setSpec({ ...spec, steps });
  };
  const addStep = (type: StepType) => {
    if (!spec) return;
    let n = spec.steps.length + 1;
    while (spec.steps.some((s) => s.id === `step${n}`)) n++;
    setSpec({ ...spec, steps: [...spec.steps, { id: `step${n}`, type, title: TYPE_META[type].label, prompt: type === "images" ? "{{item}}" : "" }] });
  };

  const start = async () => {
    if (!spec || !b) return;
    setStarting(true);
    remember(code);
    const res = await post<{ id: string }>("/api/pipelines/run", code, { spec, inputs, budget: b, dryRun });
    setStarting(false);
    if (res) setRunId(res.id);
  };

  const outputs = spec ? (shown?.steps ?? []).map((s) => ({ step: s, ev: states.get(s.id) })).filter((x) => x.ev && x.ev.state !== "waiting" && x.ev.state !== "running") : [];

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Workflow className="h-6 w-6 text-accent" /> Pipelines
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-subtle">
          Chain the generation endpoints into a <Term term="pipeline">pipeline</Term>: LLM steps write prompts, a <Term term="fanout">fan-out</Term> renders them
          in parallel on separate GPU workers, a judge picks, the video endpoint animates. Steps with no dependency on each other run at the same time.
        </p>
      </header>

      {cfgError && <Notice tone="error" title="Couldn't load the configuration">{cfgError}</Notice>}
      {!cfg || !spec ? (
        <Skeleton className="h-96" />
      ) : (
        <>
          <Card
            title={
              <span className="flex items-center gap-2">
                {shown?.name}
                {viewing && <Badge tone="neutral">last run</Badge>}
              </span>
            }
            actions={run ? <StatusBadge status={run.status} /> : null}
          >
            <div className="space-y-4">
              {shown && <Graph spec={shown} states={states} />}
              {run && <SpendMeter run={run} />}
              {viewing && (
                <Button size="sm" variant="ghost" onClick={() => setRunId(null)}>
                  Back to the editor
                </Button>
              )}
            </div>
          </Card>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)]">
            <div className="space-y-6">
              <Card
                title="Recipe"
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Braces className="h-3.5 w-3.5" />}
                    onClick={() => {
                      setJsonText(JSON.stringify(spec, null, 2));
                      setJsonError(null);
                      setShowJson((v) => !v);
                    }}
                  >
                    JSON
                  </Button>
                }
              >
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-1.5">
                    {cfg.templates.map((t) => (
                      <button key={t.id} type="button" onClick={() => loadTemplate(t.id)} className={`chip ${t.id === spec.id ? "border-accent text-accent" : ""}`} title={t.description}>
                        {t.name}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-subtle">{spec.description}</p>

                  {showJson ? (
                    <div className="space-y-2">
                      <textarea className="input min-h-80 font-mono text-[11px]" value={jsonText} onChange={(e) => setJsonText(e.target.value)} aria-label="Pipeline JSON" spellCheck={false} />
                      {jsonError && <Notice tone="error" title="Invalid JSON">{jsonError}</Notice>}
                      <Button
                        size="sm"
                        onClick={() => {
                          try {
                            const parsed = JSON.parse(jsonText) as PipelineSpec;
                            if (!Array.isArray(parsed.steps)) throw new Error("Missing a steps array.");
                            setSpec({ ...parsed, llm: parsed.llm ?? spec.llm, inputs: parsed.inputs ?? [] });
                            setShowJson(false);
                          } catch (e) {
                            setJsonError(e instanceof Error ? e.message : "Couldn't parse it.");
                          }
                        }}
                      >
                        Apply JSON
                      </Button>
                    </div>
                  ) : (
                    <>
                      {spec.inputs.map((i) => (
                        <label key={i.key} className="block">
                          <span className="mb-1 block text-xs text-subtle">
                            {i.label} <code className="text-[10px]">{`{{input.${i.key}}}`}</code>
                          </span>
                          <input className="input" value={inputs[i.key] ?? i.default ?? ""} placeholder={i.placeholder} onChange={(e) => setInputs({ ...inputs, [i.key]: e.target.value })} />
                        </label>
                      ))}
                      <label className="block">
                        <span className="mb-1 block text-xs text-subtle">LLM for text and pick steps</span>
                        <ModelSelect models={cfg.models} value={spec.llm} onChange={(m) => setSpec({ ...spec, llm: { provider: m.provider, model: m.model } })} label="Pipeline LLM" />
                      </label>
                      <div className="space-y-2">
                        <span className="block text-xs text-subtle">
                          <Term term="stepRef">Steps</Term>
                        </span>
                        {spec.steps.map((s, i) => (
                          <StepEditor
                            key={i}
                            step={s}
                            index={i}
                            steps={spec.steps}
                            onChange={(x) => updateStep(i, x)}
                            onMove={(d) => moveStep(i, d)}
                            onDelete={() => setSpec({ ...spec, steps: spec.steps.filter((_, j) => j !== i) })}
                          />
                        ))}
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {(Object.keys(TYPE_META) as StepType[]).map((t) => (
                            <Button key={t} size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => addStep(t)} disabled={spec.steps.length >= 8}>
                              {TYPE_META[t].label}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                  <div>
                    <span className="mb-1.5 block text-xs text-subtle">
                      <Term term="budget">Budget</Term>
                    </span>
                    <BudgetFields value={b!} max={cfg.maxBudget} onChange={setBudget} showTurns={false} />
                  </div>
                  <RunBar
                    code={code}
                    setCode={setCode}
                    dryRun={dryRun}
                    setDryRun={setDryRun}
                    forcedDryRun={cfg.mock}
                    running={run?.status === "running"}
                    starting={starting}
                    onStart={start}
                    onStop={() => runId && post(`/api/runs/${runId}/stop`, code)}
                    startLabel="Run pipeline"
                    estimate={est ? `≈ ${usd(est.usd)} GPU · ${est.images} images${est.videoS ? ` · ${est.videoS} s video` : ""}` : undefined}
                  />
                </div>
              </Card>
            </div>

            <div className="space-y-6">
              <Card title="Outputs">
                {runError && <Notice tone="warn" title="Run status">{runError}</Notice>}
                {!run ? (
                  <EmptyState icon={<Workflow className="h-8 w-8" />} title="Nothing run yet">
                    Pick a template, adjust the steps and run it. A dry run shows the flow without using a GPU.
                  </EmptyState>
                ) : (
                  <div className="space-y-4">
                    {run.error && <Notice tone="warn" title="Note">{run.error}</Notice>}
                    {outputs.length === 0 && <p className="text-xs text-subtle">Waiting for the first step…</p>}
                    {outputs.map(({ step, ev }) => (
                      <div key={step.id} className="space-y-2">
                        <div className="flex items-center gap-2 text-xs">
                          <StatusBadge status={ev!.state === "done" ? "done" : ev!.state === "failed" ? "failed" : "stopped"} />
                          <span className="font-medium">{step.title}</span>
                          <code className="text-subtle">{step.id}</code>
                          <span className="ml-auto font-mono text-subtle">
                            {secs(ev!.ms)}
                            {ev!.costUsd ? ` · ${usd(ev!.costUsd)}` : ""}
                          </span>
                        </div>
                        {ev!.mediaIds?.length ? (
                          <MediaGrid ids={ev!.mediaIds} media={run.media} />
                        ) : null}
                        {ev!.summary && (!ev!.mediaIds?.length || step.type === "pick") && (
                          <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs whitespace-pre-wrap">{ev!.summary}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
              <Card title={<span className="flex items-center gap-2"><History className="h-4 w-4" /> Recent runs</span>}>
                <RecentRunList runs={recent} current={runId} onPick={setRunId} />
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
