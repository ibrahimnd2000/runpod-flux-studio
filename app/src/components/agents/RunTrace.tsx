"use client";

import { Activity, AlertTriangle, Brain, Calculator, ChevronRight, Clapperboard, Cpu, Eye, Flag, ImagePlus, MessageSquare, Search, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";

import type { RunEvent, RunPollView } from "@/lib/agentTypes";

import { secs, usd } from "../format";
import { Badge } from "../ui/primitives";
import { MediaGrid } from "./shared";
import Prose from "../ui/Prose";

// The agent's trace, in order: reasoning summaries, messages, each tool call with
// its arguments and result (thumbnails for media), and per-turn token usage.

const TOOL_ICON: Record<string, typeof Wrench> = {
  generate_images: ImagePlus,
  animate_image: Clapperboard,
  view_image: Eye,
  search_library: Search,
  check_endpoints: Activity,
  estimate_cost: Calculator,
  finish: Flag,
};

/** The run's phase says a job is queued for a GPU (not yet running on one). */
export const waitingForGpu = (phase?: string) => !!phase && /waiting for a (video )?GPU/i.test(phase);

type ToolCallEvent = Extract<RunEvent, { type: "tool_call" }>;
type ToolResultEvent = Extract<RunEvent, { type: "tool_result" }>;

function Args({ call }: { call: ToolCallEvent }) {
  const a = (call.args ?? {}) as Record<string, unknown>;
  if (call.name === "generate_images" && Array.isArray(a.prompts)) {
    return (
      <ol className="list-decimal space-y-1 pl-5 text-xs">
        {(a.prompts as string[]).map((p, i) => (
          <li key={i}>{p}</li>
        ))}
        <li className="list-none text-[11px] text-subtle">
          {String(a.quality ?? "final")} · {String(a.aspect ?? "square")}
        </li>
      </ol>
    );
  }
  const json = JSON.stringify(a, null, 2);
  if (json === "{}") return null;
  return <pre className="max-h-48 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{json}</pre>;
}

function ToolCard({ call, result, media, phase }: { call: ToolCallEvent; result?: ToolResultEvent; media: RunPollView["media"]; phase?: string }) {
  const Icon = TOOL_ICON[call.name] ?? Wrench;
  const pending = !result;
  const showMedia = result?.mediaIds?.length && call.name !== "finish";
  return (
    <div className={`rounded-xl border bg-card ${result && !result.ok ? "border-red-500/40" : "border-border"}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className={`h-4 w-4 ${pending ? "animate-pulse text-accent" : "text-subtle"}`} aria-hidden />
        <code className="text-xs font-semibold">{call.name}</code>
        {pending ? (
          waitingForGpu(phase) ? (
            <Badge tone="neutral">waiting for GPU</Badge>
          ) : (
            <Badge tone="blue">{phase ? "on GPU" : "running"}</Badge>
          )
        ) : (
          <>
            <Badge tone={result.ok ? "green" : "red"}>{result.ok ? "ok" : "refused"}</Badge>
            <span className="truncate text-xs text-subtle">{result.summary}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-subtle">
              {secs(result.ms)}
              {result.costUsd ? ` · ${usd(result.costUsd)}` : ""}
            </span>
          </>
        )}
      </div>
      <details className="group border-t border-border px-3 py-2" open={call.name === "generate_images"}>
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-subtle select-none">
          <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" /> arguments
        </summary>
        <div className="mt-2">
          <Args call={call} />
        </div>
      </details>
      {showMedia ? (
        <div className="border-t border-border p-2">
          <MediaGrid ids={result.mediaIds!} media={media} cols={call.name === "search_library" || call.name === "view_image" ? "grid-cols-6" : "grid-cols-2 sm:grid-cols-4"} />
        </div>
      ) : null}
    </div>
  );
}

export default function RunTrace({ run, autoScroll = true, dense = false }: { run: RunPollView; autoScroll?: boolean; dense?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const results = new Map(run.events.filter((e): e is ToolResultEvent => e.type === "tool_result").map((e) => [e.callId, e]));
  const count = run.events.length;

  useEffect(() => {
    if (!autoScroll || run.status !== "running") return;
    const box = end.current?.parentElement;
    if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 240) end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [count, autoScroll, run.status]);

  return (
    <div className={`space-y-2.5 ${dense ? "text-xs" : "text-sm"}`}>
      {run.events.map((e) => {
        switch (e.type) {
          case "status":
            return (
              <p key={e.seq} className="text-[11px] text-subtle">
                {e.text}
              </p>
            );
          case "thinking":
            return (
              <details key={e.seq} className="group rounded-lg bg-muted/60 px-3 py-2">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-subtle select-none">
                  <Brain className="h-3.5 w-3.5" /> Reasoning
                  <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                </summary>
                <p className="mt-1.5 text-xs whitespace-pre-wrap text-subtle italic">{e.text}</p>
              </details>
            );
          case "text":
            return (
              <div key={e.seq} className="flex gap-2">
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                <Prose text={e.text} />
              </div>
            );
          case "tool_call":
            return <ToolCard key={e.seq} call={e} result={results.get(e.callId)} media={run.media} phase={run.status === "running" ? run.phase : undefined} />;
          case "llm":
            return (
              <p key={e.seq} className="flex items-center gap-1.5 font-mono text-[10px] text-subtle">
                <Cpu className="h-3 w-3" /> {e.model} · {(e.inputTokens / 1000).toFixed(1)}k in / {e.outputTokens} out · {secs(e.ms)} · {usd(e.costUsd)}
                {e.estimated ? " est." : ""}
              </p>
            );
          case "error":
            return (
              <p key={e.seq} className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                <AlertTriangle className="h-4 w-4" /> {e.text}
              </p>
            );
          default:
            return null;
        }
      })}
      {run.status === "running" && (
        <p className="flex items-center gap-2 text-xs text-subtle" aria-live="polite">
          <span className={`h-1.5 w-1.5 rounded-full ${waitingForGpu(run.phase) ? "bg-amber-500" : "animate-pulse bg-accent"}`} />{" "}
          {run.phase ?? "working…"}
        </p>
      )}
      <div ref={end} />
    </div>
  );
}
