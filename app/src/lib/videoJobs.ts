import "server-only";

import { config } from "./config";
import { saveMedia } from "./media";
import { requestCost } from "./prices";
import { videoJobStatus } from "./runpod";
import { TERMINAL, type VideoJobView, type VideoWorkerInfo } from "./types";
import { finishVideo, getVideoPending, getVideoRecord, pendingVideos } from "./videoStore";

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

// Runpod keeps an async job's result for a limited time after it ends; a job that
// still can't be read this long after submission (app down meanwhile) is given up.
const GIVE_UP_MS = 3 * 60 * 60_000;

/**
 * Checks the newest `max` in-flight video jobs (dialog closed or not), so finished
 * clips reach the library, and returns every job still in flight for the
 * Library's status tiles. Jobs past `max` are returned as last known.
 */
export async function syncPendingVideos(max = 5): Promise<VideoJobView[]> {
  const pending = pendingVideos();
  const views = await Promise.all(
    pending.map(async (p, i): Promise<VideoJobView | null> => {
      const last: VideoJobView = { id: p.id, status: "IN_QUEUE", submittedAt: p.submittedAt, input: p.input, sourcePrompt: p.sourcePrompt };
      if (i >= max) return last;
      try {
        return await refreshVideoJob(p.id);
      } catch (e) {
        if (Date.now() - p.submittedAt < GIVE_UP_MS) return last;
        console.error(`giving up on video job ${p.id}`, e);
        finishVideo({ ...last, status: "FAILED", error: "Lost track of this job: Runpod no longer has its result." });
        return null;
      }
    }),
  );
  return views.filter((v): v is VideoJobView => !!v && !TERMINAL.includes(v.status));
}
