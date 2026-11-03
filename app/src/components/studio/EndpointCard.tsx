"use client";

import { ChevronDown, Server } from "lucide-react";
import { useState } from "react";

import { ago, secs, shortGpu } from "../format";
import Notice from "../Notice";
import { endpointStatus, useEndpoint } from "../EndpointProvider";
import { Badge, Card, Skeleton } from "../ui/primitives";
import { Term } from "../ui/Tooltip";

const WORKER_STATES = [
  { key: "running", label: "Active", dot: "bg-emerald-500" },
  { key: "idle", label: "Idle (cached)", dot: "bg-sky-500" },
  { key: "initializing", label: "Initializing", dot: "bg-amber-500" },
  { key: "throttled", label: "Throttled", dot: "bg-orange-500" },
  { key: "unhealthy", label: "Unhealthy", dot: "bg-red-500" },
] as const;

const JOB_STATES = [
  ["inQueue", "Queued"],
  ["inProgress", "Running"],
  ["completed", "Done"],
  ["failed", "Failed"],
] as const;

export default function EndpointCard() {
  const { ep, error } = useEndpoint();
  const [showConfig, setShowConfig] = useState(false);
  const status = endpointStatus(ep, error);

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Server className="h-4 w-4 text-subtle" /> GPU endpoint
        </span>
      }
      actions={ep && <Badge tone={status.tone as "green"}>{status.label}</Badge>}
    >
      {!ep && !error && (
        <div className="space-y-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24" />
          <Skeleton className="h-16" />
        </div>
      )}
      {error && !ep && (
        <Notice tone="error" title="Couldn't load the endpoint status">
          {error} Retrying every 5 s.
        </Notice>
      )}
      {ep && (
        <div className="space-y-5 text-sm">
          {error && (
            <Notice tone="warn" title="Showing the last known status">
              Refresh failed ({error}). Data from {ago(ep.fetchedAt)}; retrying.
            </Notice>
          )}
          <div>
            <h3 className="mb-2 flex items-center justify-between text-xs font-medium text-subtle">
              <Term term="workers">Workers</Term>
              <span className="font-mono">
                min {ep.workersMin ?? "–"} · max {ep.workersMax ?? "–"}
              </span>
            </h3>
            <ul className="space-y-1.5">
              {WORKER_STATES.map((s) => {
                const n = ep.health?.workers[s.key] ?? 0;
                return (
                  <li key={s.key} className={`flex items-center gap-2 ${n ? "" : "text-subtle"}`}>
                    <span className={`h-2 w-2 rounded-full ${n ? s.dot : "bg-border"}`} />
                    <Term term={s.key} side="left">
                      <span>{s.label}</span>
                    </Term>
                    <span className="ml-auto font-mono">{n}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium text-subtle">Jobs on Runpod (endpoint counters)</h3>
            <div className="grid grid-cols-4 gap-1.5 text-center">
              {JOB_STATES.map(([k, label]) => (
                <div key={k} className="rounded-lg bg-muted py-2">
                  <div className="font-mono text-base">{ep.health?.jobs[k] ?? 0}</div>
                  <div className="text-[10px] text-subtle">{label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium"
              onClick={() => setShowConfig((v) => !v)}
              aria-expanded={showConfig}
            >
              Configuration
              <ChevronDown className={`h-4 w-4 text-subtle transition-transform ${showConfig ? "rotate-180" : ""}`} />
            </button>
            {showConfig && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 border-t border-border px-3 py-3 text-xs">
                <dt className="text-subtle">Image</dt>
                <dd className="text-right font-mono break-all">{ep.image?.split("/").pop() ?? "–"}</dd>
                <dt className="text-subtle">
                  <Term term="gpuPool" side="right">GPU pools</Term>
                </dt>
                <dd className="text-right font-mono">{ep.gpuPools.join(", ") || "–"}</dd>
                <dt className="text-subtle">Eligible GPUs</dt>
                <dd className="flex flex-wrap justify-end gap-1">
                  {ep.gpuTypes.map((g) => (
                    <Badge key={g}>{shortGpu(g)}</Badge>
                  ))}
                </dd>
                <dt className="text-subtle">
                  <Term term="excluded" side="right">Excluded</Term>
                </dt>
                <dd className="text-right">{ep.excludedTypes.map(shortGpu).join(", ") || "none"}</dd>
                <dt className="text-subtle">
                  <Term term="autoscaling" side="right">Autoscaling</Term>
                </dt>
                <dd className="text-right">
                  {ep.scaling?.type === "QUEUE_DELAY" ? `+1 worker if a job waits > ${ep.scaling.queueDelay} s` : (ep.scaling?.type ?? "–")}
                </dd>
                <dt className="text-subtle">
                  <Term term="idleTimeout" side="right">Idle timeout</Term>
                </dt>
                <dd className="text-right font-mono">{ep.idleTimeoutS ?? "–"} s</dd>
                <dt className="text-subtle">
                  <Term term="flashboot" side="right">FlashBoot</Term>
                </dt>
                <dd className="text-right">{ep.flashboot === "FLASHBOOT" ? "on" : (ep.flashboot ?? "–")}</dd>
                <dt className="text-subtle">Job timeout</dt>
                <dd className="text-right font-mono">{secs(ep.executionTimeoutMs, 0)}</dd>
              </dl>
            )}
          </div>
          <p className="font-mono text-[11px] text-subtle">
            {ep.id} · live from Runpod /health + REST v2
          </p>
        </div>
      )}
    </Card>
  );
}
