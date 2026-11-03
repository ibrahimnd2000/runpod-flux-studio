import "server-only";

import type { VideoModel } from "./types";

// Server-side configuration. None of these are NEXT_PUBLIC_, so they never reach
// the browser bundle. On Runpod, RUNPOD_API_KEY and DEMO_ACCESS_CODE come from
// Runpod Secrets ({{ RUNPOD_SECRET_... }} in the pod's environment).

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  apiKey: process.env.RUNPOD_API_KEY ?? "",
  endpointId: process.env.RUNPOD_IMAGE_ENDPOINT_ID ?? "",
  // Empty code = generation disabled (fail closed); dashboards stay readable.
  accessCode: process.env.DEMO_ACCESS_CODE ?? "",
  dailyCap: int("DAILY_JOB_CAP", 100),
  perIpPer10Min: int("RATE_LIMIT_PER_10_MIN", 12),
  // Largest bulk run; every image in it counts against the limits above.
  bulkMax: int("BULK_MAX", 8),
  maxSide: int("MAX_SIDE", 1024),
  maxSteps: int("MAX_STEPS", 28),
  // Image-to-video endpoints, one per model family; none set = Animate is hidden.
  videoEndpoints: {
    wan22: process.env.RUNPOD_WAN_ENDPOINT_ID ?? "", // Wan 2.2 TI2V-5B: 48 GB GPUs, no audio
    ltx2: process.env.RUNPOD_VIDEO_ENDPOINT_ID ?? "", // LTX-2.5: 80 GB GPUs, with audio
  } as Record<VideoModel, string>,
  // A clip costs ~10x an image, so videos get their own, smaller daily cap.
  videoDailyCap: int("VIDEO_DAILY_CAP", 20),
  videoMaxFrames: int("VIDEO_MAX_FRAMES", 121),
  // Job history survives restarts when this points at a persistent volume.
  dataDir: process.env.DATA_DIR ?? "",
};

export function requireRunpod() {
  if (!config.apiKey || !config.endpointId) {
    throw new Error("RUNPOD_API_KEY and RUNPOD_IMAGE_ENDPOINT_ID must be set on the server");
  }
}

/** Video models this deployment can run, fastest first. */
export const videoModels = (): VideoModel[] =>
  (["wan22", "ltx2"] as const).filter((m) => !!config.videoEndpoints[m]);
