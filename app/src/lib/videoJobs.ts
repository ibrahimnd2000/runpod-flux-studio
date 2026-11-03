import "server-only";

import { config } from "./config";
import { saveMedia } from "./media";
import { requestCost } from "./prices";
import { videoJobStatus } from "./runpod";
import { TERMINAL, type VideoJobView, type VideoWorkerInfo } from "./types";
import { finishVideo, getVideoPending, getVideoRecord, pendingVideoIds } from "./videoStore";

interface VideoOutput {
  video?: string;
  bytes?: number;
  seed?: number;
  timings?: { inference_ms: number; encode_ms: number; total_ms: number };
  worker?: VideoWorkerInfo;
  params?: Record<string, unknown>;
  error?: string;
}

/**
 * Checks Runpod for one video job this app submitted. On completion the MP4
 * (base64 in the job result) is written to the library once and the job is
 * recorded; callers get a /api/media URL, never the base64.
 * Returns null if the job is unknown; throws if Runpod can't be reached.
 */
export async function refreshVideoJob(id: string): Promise<VideoJobView | null> {
  const done = getVideoRecord(id);
  if (done) return done;
  const pending = getVideoPending(id);
  if (!pending) return null;

  const s = await videoJobStatus(config.videoEndpoints[pending.input.model ?? "ltx2"], id);
  const view: VideoJobView = {
    id,
    status: s.status,
    submittedAt: pending.submittedAt,
    input: pending.input,
    sourcePrompt: pending.sourcePrompt,
    delayMs: s.delayTime,
    executionMs: s.executionTime,
  };
  if (s.status === "IN_PROGRESS" && s.output && typeof s.output === "object" && "step" in s.output) {
    view.progress = s.output as VideoJobView["progress"];
  }
  if (!TERMINAL.includes(s.status)) return view;

  view.clientWallMs = Date.now() - pending.submittedAt;
  const out = (s.output ?? {}) as VideoOutput;
  view.error = s.error || out.error;
  if (s.status === "COMPLETED" && out.video) {
    view.costUsd = requestCost(out.worker?.gpu, s.executionTime);
    const saved = saveMedia(
      {
        id,
        kind: "video",
        createdAt: Date.now(),
        prompt: pending.input.prompt,
        sourceId: pending.input.sourceId,
        width: Number(out.params?.width ?? 0),
        height: Number(out.params?.height ?? 0),
        steps: Number(out.params?.steps ?? 8),
        seed: out.seed,
        gpu: out.worker?.gpu,
        executionMs: s.executionTime,
        costUsd: view.costUsd,
        durationS: Number(out.params?.duration_s ?? 0) || undefined,
      },
      out.video,
    );
    if (!saved) view.error = "The video was generated but couldn't be saved to the library.";
    view.output = {
      mediaId: id,
      url: `/api/media/${id}`,
      bytes: out.bytes ?? 0,
      seed: out.seed ?? 0,
      timings: out.timings!,
      worker: out.worker,
      params: out.params ?? {},
    };
  }
  finishVideo(view);
  return view;
}

/** Finish any video jobs nobody is watching (dialog closed), so clips still reach the library. */
export async function syncPendingVideos(max = 5) {
  await Promise.allSettled(pendingVideoIds().slice(0, max).map((id) => refreshVideoJob(id)));
}
