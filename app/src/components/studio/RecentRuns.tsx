"use client";

import { Activity } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";

import type { HistoryView } from "@/lib/types";

import { ago, secs, shortGpu, usd } from "../format";
import Notice from "../Notice";
import { Badge, Card, EmptyState, Skeleton, Stat } from "../ui/primitives";
import { Term } from "../ui/Tooltip";

export default function RecentRuns({ h, error }: { h: HistoryView | null; error: string | null }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-subtle" /> Recent runs
        </span>
      }
      actions={
        h && (
          <span className="text-xs text-subtle">
            {h.limits.usedToday}/{h.limits.dailyCap} images today
          </span>
        )
      }
    >
      {!h && !error && <Skeleton className="h-48" />}
      {!h && error && (
        <Notice tone="warn" title="History isn't available right now">
          {error} Retrying every 15 s.
        </Notice>
      )}
      {h && <Body h={h} error={error} />}
    </Card>
  );
}

function Body({ h, error }: { h: HistoryView; error: string | null }) {
  const s = h.stats;
  // Oldest first; queue capped at 60 s so one long cold start doesn't flatten the chart.
  const chart = [...h.jobs]
    .filter((j) => j.status === "COMPLETED")
    .reverse()
    .slice(-40)
    .map((j, i) => ({
      n: i + 1,
      queue: Math.min((j.delayMs ?? 0) / 1000, 60),
      execution: (j.executionMs ?? 0) / 1000,
    }));

  return (
    <div className="space-y-5">
      {error && (
        <Notice tone="warn" title="Showing the last loaded history">
          Refresh failed ({error}); retrying every 15 s.
        </Notice>
      )}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat label={<Term term="execution">Warm GPU time p50</Term>} value={secs(s.warmExecP50Ms)} sub={`p90 ${secs(s.warmExecP90Ms)}`} />
        <Stat label={<Term term="coldStart">Cold start p50</Term>} value={secs(s.coldDelayP50Ms)} sub={`${s.cold} cold of ${s.completed}`} />
        <Stat label={<Term term="cost">Avg cost / image</Term>} value={usd(s.avgCostUsd)} sub={`total ${usd(s.totalCostUsd)}`} />
        <Stat label="Jobs" value={s.completed} sub={s.failed ? `${s.failed} failed` : "all succeeded"} />
      </div>

      {chart.length === 0 ? (
        <EmptyState icon={<Activity className="h-7 w-7" />} title="No runs yet">
          Every image you generate shows up here with its queue time, GPU time and cost.
        </EmptyState>
      ) : (
        <div>
          <div className="mb-2 flex items-center gap-4 text-[11px] text-subtle">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-amber-500" />
              queue + cold start (capped at 60 s)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-accent" />
              GPU execution
            </span>
          </div>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ left: -18, right: 4, top: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="n" tick={{ fontSize: 11, fill: "var(--subtle)" }} tickLine={false} axisLine={false} />
                <YAxis unit="s" tick={{ fontSize: 11, fill: "var(--subtle)" }} tickLine={false} axisLine={false} />
                <ChartTooltip
                  cursor={{ fill: "var(--muted)" }}
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  formatter={(v, name) => [`${Number(v).toFixed(1)} s`, name]}
                  labelFormatter={(n) => `Run #${n}`}
                />
                <Bar dataKey="queue" stackId="t" name="Queue + cold start" fill="#f59e0b" />
                <Bar dataKey="execution" stackId="t" name="GPU execution" fill="var(--accent)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {h.jobs.length > 0 && (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-subtle">
              <tr className="border-b border-border">
                <th className="py-2 pr-3 pl-5 font-medium">When</th>
                <th className="pr-3 font-medium">Prompt</th>
                <th className="pr-3 font-medium">Size</th>
                <th className="pr-3 font-medium">GPU</th>
                <th className="pr-3 text-right font-medium">Queue</th>
                <th className="pr-3 text-right font-medium">GPU time</th>
                <th className="pr-5 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {h.jobs.slice(0, 12).map((j) => (
                <tr key={j.id} className="border-b border-border/60 last:border-0 hover:bg-muted/50">
                  <td className="py-2 pr-3 pl-5 whitespace-nowrap text-subtle">{ago(j.submittedAt)}</td>
                  <td className="max-w-[18rem] truncate pr-3" title={j.input.prompt}>
                    {j.error ? <span className="text-red-500">{j.error}</span> : j.input.prompt}
                  </td>
                  <td className="pr-3 font-mono whitespace-nowrap">
                    {j.input.width}×{j.input.height}
                  </td>
                  <td className="pr-3 whitespace-nowrap">
                    {shortGpu(j.output?.worker?.gpu)}
                    {j.output?.worker?.cold_start && (
                      <Badge tone="amber" className="ml-1.5">
                        cold
                      </Badge>
                    )}
                  </td>
                  <td className="pr-3 text-right font-mono">{secs(j.delayMs)}</td>
                  <td className="pr-3 text-right font-mono">{secs(j.executionMs)}</td>
                  <td className="pr-5 text-right font-mono">{usd(j.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-subtle">
        Cost = GPU execution time × list price (checked {h.pricesChecked}); excludes billed idle time. Demo limits: max{" "}
        {h.limits.maxSide}px, {h.limits.maxSteps} steps, {h.limits.bulkMax} images per bulk run,{" "}
        {h.limits.perIpPer10Min} images per 10 min per visitor.
      </p>
    </div>
  );
}
