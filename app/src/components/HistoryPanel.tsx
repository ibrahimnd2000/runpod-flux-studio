"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { HistoryView } from "@/lib/types";

import { ago, secs, shortGpu, usd } from "./format";

export default function HistoryPanel({ h }: { h: HistoryView | null }) {
  if (!h) return null;
  const s = h.stats;
  // Oldest first, warm and cold split so a 10-minute cold start doesn't flatten the chart.
  const chart = [...h.jobs]
    .filter((j) => j.status === "COMPLETED")
    .reverse()
    .slice(-40)
    .map((j, i) => ({
      n: i + 1,
      queue: Math.min((j.delayMs ?? 0) / 1000, 60),
      execution: (j.executionMs ?? 0) / 1000,
      cold: j.output?.worker?.cold_start,
    }));

  return (
    <section className="card">
      <h2 className="card-title">History</h2>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Warm execution p50 / p90" value={`${secs(s.warmExecP50Ms)} / ${secs(s.warmExecP90Ms)}`} />
        <Stat label="Cold start (delay) p50" value={secs(s.coldDelayP50Ms)} />
        <Stat label="Avg cost / image" value={usd(s.avgCostUsd)} />
        <Stat
          label="Jobs (ok · failed · cold)"
          value={`${s.completed} · ${s.failed} · ${s.cold}`}
        />
      </div>

      {chart.length > 0 && (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ left: -16, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="n" tick={{ fontSize: 11, fill: "var(--subtle)" }} />
              <YAxis unit="s" tick={{ fontSize: 11, fill: "var(--subtle)" }} />
              <Tooltip
                contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", fontSize: 12 }}
                formatter={(v, name) => [`${Number(v).toFixed(1)} s`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="queue" stackId="t" name="queue + cold start (capped 60 s)" fill="#f59e0b" />
              <Bar dataKey="execution" stackId="t" name="execution" fill="#0ea5e9" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-subtle">
            <tr>
              <th className="py-1.5 pr-3 font-medium">When</th>
              <th className="pr-3 font-medium">Prompt</th>
              <th className="pr-3 font-medium">Size</th>
              <th className="pr-3 font-medium">GPU</th>
              <th className="pr-3 font-medium">Cold</th>
              <th className="pr-3 text-right font-medium">Queue</th>
              <th className="pr-3 text-right font-medium">Exec</th>
              <th className="text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {h.jobs.slice(0, 25).map((j) => (
              <tr key={j.id} className="border-t border-border">
                <td className="py-1.5 pr-3 whitespace-nowrap">{ago(j.submittedAt)}</td>
                <td className="max-w-[16rem] truncate pr-3" title={j.input.prompt}>
                  {j.error ? <span className="text-red-600">{j.error}</span> : j.input.prompt}
                </td>
                <td className="pr-3 whitespace-nowrap">
                  {j.input.width}², {j.input.num_inference_steps}
                </td>
                <td className="pr-3 whitespace-nowrap">{shortGpu(j.output?.worker?.gpu)}</td>
                <td className="pr-3">{j.output?.worker?.cold_start ? "yes" : ""}</td>
                <td className="pr-3 text-right font-mono">{secs(j.delayMs)}</td>
                <td className="pr-3 text-right font-mono">{secs(j.executionMs)}</td>
                <td className="text-right font-mono">{usd(j.costUsd)}</td>
              </tr>
            ))}
            {h.jobs.length === 0 && (
              <tr>
                <td colSpan={8} className="py-3 text-subtle">
                  No jobs yet from this app.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-subtle">
        Cost = executionTime × GPU list price (prices checked {h.pricesChecked}); excludes billed idle time. Demo limits:{" "}
        {h.limits.usedToday}/{h.limits.dailyCap} images today, max {h.limits.maxSide}px, {h.limits.maxSteps} steps.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted p-3">
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
}
