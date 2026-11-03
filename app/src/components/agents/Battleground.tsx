"use client";

import { Gavel, Medal, Swords, ThumbsUp, Trophy } from "lucide-react";
import { useEffect, useState } from "react";

import type { AgentsConfigView, BattleView, Budget, Contestant, LeaderboardRow, PersonaId, RunPollView, Side } from "@/lib/agentTypes";

import { getJson } from "../api";
import { ago, usd } from "../format";
import { celebrate } from "../fun/EasterEggs";
import Notice from "../Notice";
import { Badge, Button, Card, EmptyState, Segmented, Skeleton } from "../ui/primitives";
import { Term } from "../ui/Tooltip";
import { useAccessCode } from "../useAccessCode";
import { EXAMPLE_BRIEFS, useRunParam } from "./AgentPlayground";
import RunTrace from "./RunTrace";
import { BudgetFields, elapsedS, MediaGrid, ModelSelect, RunBar, SpendMeter, StatusBadge, useAgentsConfig, useNow, usePost, useRun } from "./shared";

const SIDES: Side[] = ["a", "b"];
const SIDE_STYLE = { a: "text-sky-600 dark:text-sky-400", b: "text-rose-600 dark:text-rose-400" };

function label(cfg: AgentsConfigView | null, c?: Contestant) {
  if (!c) return "";
  const m = cfg?.models.find((x) => x.provider === c.provider && x.model === c.model)?.label ?? c.model;
  const p = cfg?.personas.find((x) => x.id === c.persona)?.label ?? c.persona;
  return `${m} · ${p}`;
}

function useBattle(id: string | null) {
  const [battle, setBattle] = useState<BattleView | null>(null);
  useEffect(() => {
    const reset = setTimeout(() => setBattle(null), 0);
    if (!id) return () => clearTimeout(reset);
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const r = await getJson<BattleView>(`/api/battles/${id}`);
      if (!alive) return;
      if (r.ok) {
        setBattle(r.data);
        if (r.data.status === "done" || r.data.status === "failed") return;
      } else if (r.status === 404) return;
      timer = setTimeout(poll, 2000);
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(reset);
      clearTimeout(timer);
    };
  }, [id]);
  return [battle, setBattle] as const;
}

function useBoard(refreshKey: unknown) {
  const [data, setData] = useState<{ battles: BattleView[]; leaderboard: LeaderboardRow[] } | null>(null);
  useEffect(() => {
    let alive = true;
    getJson<{ battles: BattleView[]; leaderboard: LeaderboardRow[] }>("/api/battles").then((r) => alive && r.ok && setData(r.data));
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return data;
}

function ContestantPicker({ cfg, side, value, onChange }: { cfg: AgentsConfigView; side: Side; value: Contestant; onChange: (c: Contestant) => void }) {
  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <p className={`text-xs font-semibold tracking-wide uppercase ${SIDE_STYLE[side]}`}>Agent {side.toUpperCase()}</p>
      <ModelSelect models={cfg.models} value={value} onChange={(m) => onChange({ ...value, provider: m.provider, model: m.model })} label={`Agent ${side} model`} />
      <Segmented label={`Agent ${side} persona`} value={value.persona} onChange={(p: PersonaId) => onChange({ ...value, persona: p })} options={cfg.personas.map((p) => ({ value: p.id, label: p.label, title: p.description }))} />
    </div>
  );
}

function Arena({ side, run, cfg, contestant, winner }: { side: Side; run: RunPollView | null; cfg: AgentsConfigView | null; contestant: Contestant; winner?: Side | "tie" }) {
  return (
    <Card
      className={winner === side ? "ring-2 ring-amber-400" : ""}
      title={
        <span className="flex items-center gap-2">
          <span className={`font-semibold ${SIDE_STYLE[side]}`}>{side.toUpperCase()}</span>
          <span className="truncate font-normal">{label(cfg, contestant)}</span>
          {winner === side && <Trophy className="h-4 w-4 text-amber-500" />}
        </span>
      }
      actions={<StatusBadge status={run?.status} />}
    >
      {!run ? (
        <Skeleton className="h-60" />
      ) : (
        <div className="space-y-3">
          <SpendMeter run={run} compact />
          {run.status !== "running" && run.result && (
            <div className="space-y-2 rounded-lg bg-muted/50 p-2.5">
              <MediaGrid ids={run.result.mediaIds.slice(0, 4)} media={run.media} cols="grid-cols-2" />
              <p className="text-xs whitespace-pre-wrap">{run.result.text}</p>
              {run.error && <p className="text-[11px] text-amber-600">{run.error}</p>}
            </div>
          )}
          <div className="max-h-[55vh] overflow-y-auto pr-1">
            <RunTrace run={run} dense autoScroll={false} />
          </div>
        </div>
      )}
    </Card>
  );
}

/** Head-to-head numbers; the better value in each row is highlighted. */
function Compare({ runs }: { runs: Record<Side, RunPollView | null> }) {
  const a = runs.a;
  const b = runs.b;
  const now = useNow(a?.status === "running" || b?.status === "running");
  if (!a || !b) return null;
  const secs = (r: RunPollView) => elapsedS(r, now);
  const rows: { k: string; a: number; b: number; fmt: (v: number) => string; lower: boolean }[] = [
    { k: "Total spend", a: a.spend.gpuUsd + a.spend.llmUsd, b: b.spend.gpuUsd + b.spend.llmUsd, fmt: usd, lower: true },
    { k: "GPU", a: a.spend.gpuUsd, b: b.spend.gpuUsd, fmt: usd, lower: true },
    { k: "LLM", a: a.spend.llmUsd, b: b.spend.llmUsd, fmt: usd, lower: true },
    { k: "Wall time", a: secs(a), b: secs(b), fmt: (v) => `${v.toFixed(0)} s`, lower: true },
    { k: "Images rendered", a: a.spend.images, b: b.spend.images, fmt: String, lower: true },
    { k: "Tool calls", a: a.spend.toolCalls, b: b.spend.toolCalls, fmt: String, lower: true },
    { k: "Delivered", a: a.result?.mediaIds.length ?? 0, b: b.result?.mediaIds.length ?? 0, fmt: String, lower: false },
  ];
  const best = (r: (typeof rows)[number], s: Side) => {
    if (r.a === r.b) return false;
    const mine = s === "a" ? r.a : r.b;
    const other = s === "a" ? r.b : r.a;
    return r.lower ? mine < other : mine > other;
  };
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-subtle">
          <th className="py-1 text-left font-normal" />
          <th className={`py-1 text-right font-semibold ${SIDE_STYLE.a}`}>A</th>
          <th className={`py-1 text-right font-semibold ${SIDE_STYLE.b}`}>B</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {rows.map((r) => (
          <tr key={r.k} className="border-t border-border">
            <td className="py-1.5 font-sans text-subtle">{r.k}</td>
            {SIDES.map((s) => (
              <td key={s} className={`py-1.5 text-right ${best(r, s) ? "font-semibold text-emerald-600 dark:text-emerald-400" : ""}`}>
                {r.fmt(s === "a" ? r.a : r.b)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Verdict({ battle, onVote, voting }: { battle: BattleView; onVote: (v: Side | "tie") => void; voting: boolean }) {
  const j = battle.judge;
  return (
    <div className="space-y-4">
      {battle.status === "judging" && <p className="flex items-center gap-2 text-sm text-subtle"><Gavel className="h-4 w-4 animate-bounce" /> The judge is looking at both deliveries…</p>}
      {battle.judgeError && <Notice tone="warn" title="No verdict">{battle.judgeError}</Notice>}
      {j && (
        <div className="space-y-3">
          <p className="text-sm">
            <Term term="judge">Judge</Term>:{" "}
            {j.winner === "tie" ? <b>tie</b> : <b className={SIDE_STYLE[j.winner]}>Agent {j.winner.toUpperCase()} wins</b>}
            <span className="ml-2 text-[11px] text-subtle">
              {j.model} · {usd(j.costUsd)}
            </span>
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-subtle">
                <th className="py-1 text-left font-normal">Score /10</th>
                <th className="py-1 text-right font-normal">brief</th>
                <th className="py-1 text-right font-normal">quality</th>
                <th className="py-1 text-right font-normal">efficiency</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {SIDES.map((s) => (
                <tr key={s} className="border-t border-border">
                  <td className={`py-1.5 font-sans font-semibold ${SIDE_STYLE[s]}`}>{s.toUpperCase()}</td>
                  <td className="py-1.5 text-right">{j.scores[s].brief}</td>
                  <td className="py-1.5 text-right">{j.scores[s].quality}</td>
                  <td className="py-1.5 text-right">{j.scores[s].efficiency}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs whitespace-pre-wrap text-subtle">{j.reasoning}</p>
        </div>
      )}
      {battle.status === "done" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-subtle">Your verdict{battle.vote ? ` (voted ${battle.vote})` : ""}:</span>
          {(["a", "tie", "b"] as const).map((v) => (
            <Button key={v} size="sm" variant={battle.vote === v ? "primary" : "secondary"} loading={voting} icon={<ThumbsUp className="h-3.5 w-3.5" />} onClick={() => onVote(v)}>
              {v === "tie" ? "Tie" : `${v.toUpperCase()} is better`}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Battleground() {
  const { cfg, error: cfgError } = useAgentsConfig();
  const { code, setCode, remember } = useAccessCode();
  const post = usePost();
  const [brief, setBrief] = useState(EXAMPLE_BRIEFS[1]);
  const [picks, setPicks] = useState<Record<Side, Contestant> | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [autoJudge, setAutoJudge] = useState(true);
  const [starting, setStarting] = useState(false);
  const [voting, setVoting] = useState(false);
  const [battleId, setBattleId] = useRunParam("battle");
  const [battle, setBattle] = useBattle(battleId);
  const runA = useRun(battle?.runs.a ?? null).run;
  const runB = useRun(battle?.runs.b ?? null).run;
  const board = useBoard(`${battle?.status}-${battle?.vote}`);

  // Default line-up: the open model on Runpod vs Claude, when both exist.
  const defaults = (): Record<Side, Contestant> => {
    const ms = cfg!.models;
    const first = ms.find((m) => m.provider === "runpod") ?? ms[0];
    const second = ms.find((m) => m.provider === "claude") ?? ms.find((m) => m !== first) ?? ms[0];
    return {
      a: { provider: first.provider, model: first.model, persona: "balanced" },
      b: { provider: second.provider, model: second.model, persona: "balanced" },
    };
  };
  const lineup = picks ?? (cfg ? defaults() : null);
  const b = budget ?? cfg?.defaultBudget;
  const contestants = battle?.contestants ?? lineup;
  const winner = battle?.vote ?? battle?.judge?.winner;

  const start = async () => {
    if (!lineup || !b) return;
    setStarting(true);
    remember(code);
    const res = await post<BattleView>("/api/battles", code, { brief, a: lineup.a, b: lineup.b, budget: b, dryRun, judge: autoJudge });
    setStarting(false);
    if (res) {
      setBattle(res);
      setBattleId(res.id);
    }
  };

  const vote = async (v: Side | "tie") => {
    if (!battle) return;
    setVoting(true);
    remember(code);
    const res = await post<BattleView>(`/api/battles/${battle.id}/vote`, code, { vote: v });
    setVoting(false);
    if (res) {
      setBattle(res);
      if (v !== "tie") celebrate();
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Swords className="h-6 w-6 text-accent" /> Battleground
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-subtle">
          Two agents, the same brief, the same budget, at the same time, on the same GPU endpoints. Watch them plan and spend side by side, then let
          the <Term term="judge">judge</Term> score them, or vote yourself. Results feed an <Term term="elo">Elo</Term> leaderboard.
        </p>
      </header>

      {cfgError && <Notice tone="error" title="Couldn't load the configuration">{cfgError}</Notice>}
      {!cfg || !lineup ? (
        <Skeleton className="h-72" />
      ) : (
        <Card title="Set up a battle">
          <div className="space-y-4">
            <textarea className="input min-h-20" value={brief} onChange={(e) => setBrief(e.target.value)} aria-label="Brief" maxLength={2000} />
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_BRIEFS.map((x, i) => (
                <button key={i} type="button" className="chip" onClick={() => setBrief(x)}>
                  Example {i + 1}
                </button>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {SIDES.map((s) => (
                <ContestantPicker key={s} cfg={cfg} side={s} value={lineup[s]} onChange={(c) => setPicks({ ...lineup, [s]: c })} />
              ))}
            </div>
            <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div>
                <span className="mb-1.5 block text-xs text-subtle">
                  <Term term="budget">Budget per agent</Term>
                </span>
                <BudgetFields value={b!} max={cfg.maxBudget} onChange={setBudget} />
              </div>
              <label className={`flex items-end gap-2 pb-2 text-xs ${cfg.judge ? "" : "opacity-60"}`}>
                <input type="checkbox" className="accent-[var(--accent)]" disabled={!cfg.judge} checked={autoJudge && !!cfg.judge} onChange={(e) => setAutoJudge(e.target.checked)} />
                <Gavel className="h-3.5 w-3.5 text-subtle" />
                {cfg.judge ? "Claude judges automatically" : "No judge configured: you vote"}
              </label>
            </div>
            <RunBar
              code={code}
              setCode={setCode}
              dryRun={dryRun}
              setDryRun={setDryRun}
              forcedDryRun={cfg.mock}
              running={battle?.status === "running" || battle?.status === "judging"}
              starting={starting}
              onStart={start}
              startLabel="Start battle"
            />
          </div>
        </Card>
      )}

      {battle && contestants && (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Arena side="a" run={runA} cfg={cfg} contestant={contestants.a} winner={winner} />
            <Arena side="b" run={runB} cfg={cfg} contestant={contestants.b} winner={winner} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Head to head" actions={<StatusBadge status={battle.status === "judging" ? "judging" : battle.status === "done" ? "done" : battle.status === "failed" ? "failed" : "running"} />}>
              <Compare runs={{ a: runA, b: runB }} />
            </Card>
            <Card title={<span className="flex items-center gap-2"><Gavel className="h-4 w-4" /> Verdict</span>}>
              {battle.status === "running" ? <p className="text-xs text-subtle">Waiting for both agents to finish…</p> : <Verdict battle={battle} onVote={vote} voting={voting} />}
            </Card>
          </div>
        </>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title={<span className="flex items-center gap-2"><Medal className="h-4 w-4" /> Leaderboard</span>}>
          {!board ? (
            <Skeleton className="h-24" />
          ) : !board.leaderboard.length ? (
            <EmptyState icon={<Trophy className="h-7 w-7" />} title="No rated battles yet">
              A battle counts once the judge or a person has picked a winner.
            </EmptyState>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-subtle">
                  <th className="py-1 text-left font-normal">#</th>
                  <th className="py-1 text-left font-normal">Contestant</th>
                  <th className="py-1 text-right font-normal">
                    <Term term="elo">Elo</Term>
                  </th>
                  <th className="py-1 text-right font-normal">W-L-T</th>
                  <th className="py-1 text-right font-normal">avg $</th>
                  <th className="py-1 text-right font-normal">avg time</th>
                </tr>
              </thead>
              <tbody>
                {board.leaderboard.map((r, i) => (
                  <tr key={r.key} className="border-t border-border">
                    <td className="py-1.5">{i === 0 ? <Trophy className="h-3.5 w-3.5 text-amber-500" /> : i + 1}</td>
                    <td className="py-1.5">{label(cfg, r.contestant)}</td>
                    <td className="py-1.5 text-right font-mono font-semibold">{r.rating}</td>
                    <td className="py-1.5 text-right font-mono">
                      {r.wins}-{r.losses}-{r.ties}
                    </td>
                    <td className="py-1.5 text-right font-mono">{usd(r.avgUsd)}</td>
                    <td className="py-1.5 text-right font-mono">{r.avgSeconds.toFixed(0)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Recent battles">
          {!board?.battles.length ? (
            <p className="text-xs text-subtle">None yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {board.battles.slice(0, 8).map((x) => {
                const w = x.vote ?? x.judge?.winner;
                return (
                  <li key={x.id}>
                    <button type="button" className={`flex w-full items-center gap-2 py-2 text-left text-xs hover:text-accent ${x.id === battleId ? "text-accent" : ""}`} onClick={() => setBattleId(x.id)}>
                      <Badge tone={w ? "violet" : "neutral"}>{w ? (w === "tie" ? "tie" : `${w.toUpperCase()} won`) : x.status}</Badge>
                      <span className="min-w-0 flex-1 truncate">{x.brief}</span>
                      <span className="text-subtle">{ago(x.createdAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
