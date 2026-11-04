"use client";

import { AlertTriangle, Clapperboard, Loader2 } from "lucide-react";

import { TERMINAL, type MediaItem, type VideoJobView } from "@/lib/types";

import { secs } from "../format";
import { Badge } from "../ui/primitives";

const MODEL_LABEL = { wan22: "Wan 2.2", ltx2: "LTX-2.5" } as const;

/**
 * A clip that isn't in the library yet: still queued or generating (the Animate
 * dialog may be closed), or failed. Shows the source frame with the job's status.
 */
export default function VideoJobTile({ job, source, now }: { job: VideoJobView; source?: MediaItem; now: number }) {
  const failed = TERMINAL.includes(job.status);
  const generating = job.status === "IN_PROGRESS";
  const p = job.progress;
  const elapsed = now ? Math.max(now - job.submittedAt, 0) : 0;
  const state = failed
    ? job.status === "COMPLETED"
      ? "Couldn't save"
      : job.status === "FAILED"
        ? "Failed"
        : job.status.toLowerCase().replace("_", " ")
    : generating
      ? "Generating"
      : "Queued";

  return (
    <figure
      className={`overflow-hidden rounded-xl border bg-card ${failed ? "border-red-500/40" : "border-accent/40"}`}
      aria-label={`Video ${state.toLowerCase()}: ${job.input.prompt}`}
    >
      <div className="relative bg-muted" style={{ aspectRatio: source ? source.width / source.height : 1 }}>
        {source && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/media/${source.id}`} alt="" className="h-full w-full object-cover opacity-40" />
        )}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center text-xs">
          {failed ? (
            <>
              <AlertTriangle className="h-6 w-6 text-red-500" />
              <span className="line-clamp-3 font-medium" title={job.error}>
                {job.error ?? "The video job ended without a clip."}
              </span>
            </>
          ) : (
            <>
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
              <span className="font-medium">{p ? `Step ${p.step} of ${p.total_steps}` : generating ? "Generating…" : "Waiting for a video GPU…"}</span>
              {p && (
                <div className="h-1.5 w-3/4 overflow-hidden rounded-full bg-background/70">
                  <div className="h-full bg-accent transition-all" style={{ width: `${(100 * p.step) / p.total_steps}%` }} />
                </div>
              )}
            </>
          )}
        </div>
        <span className="absolute top-2 left-2">
          <Badge tone={failed ? "red" : generating ? "blue" : "neutral"}>{state}</Badge>
        </span>
        <span className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white">
          <Clapperboard className="h-3 w-3" /> {MODEL_LABEL[job.input.model ?? "ltx2"]}
        </span>
      </div>
      <figcaption className="space-y-1 p-3 text-xs">
        <p className="line-clamp-2 leading-snug" title={job.input.prompt}>
          {job.input.prompt}
        </p>
        <p className="flex justify-between text-[11px] text-subtle">
          <span>{failed ? (job.executionMs ? `${secs(job.executionMs)} of GPU time` : "never reached a GPU") : `${elapsed >= 60_000 ? `${Math.floor(elapsed / 60_000)} min ${Math.floor((elapsed % 60_000) / 1000)} s` : secs(elapsed, 0)} so far`}</span>
          <span>
            {job.input.resolution} · {job.input.num_frames} frames
          </span>
        </p>
      </figcaption>
    </figure>
  );
}
