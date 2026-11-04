// Shapes shared by the API routes and the browser. Nothing secret lives here.

export type JobStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export const TERMINAL: JobStatus[] = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];

export interface GenerateInput {
  prompt: string;
  width: number;
  height: number;
  num_inference_steps: number;
  guidance_scale: number;
  seed?: number;
  /** A ready LoRA from /lora and its strength (0-2). */
  lora?: { id: string; scale: number };
}

/** The `worker` block returned by workers/image/handler.py. */
export interface WorkerInfo {
  id: string | null;
  gpu: string;
  vram_total_gb: number;
  peak_vram_gb: number;
  cold_start: boolean;
  model_load_ms: number;
  process_ready_s: number;
  jobs_served: number;
}

export interface HandlerOutput {
  images: string[];
  seed: number;
  timings: { inference_ms: number; encode_ms?: number; total_ms: number };
  worker?: WorkerInfo;
  params: Record<string, unknown>;
  notes?: string[];
  error?: string;
}

/** What /api/jobs/[id] returns to the browser. */
export interface JobView {
  id: string;
  status: JobStatus;
  submittedAt: number;
  input: GenerateInput;
  progress?: { step: number; total_steps: number };
  delayMs?: number;
  executionMs?: number;
  clientWallMs?: number;
  output?: Omit<HandlerOutput, "images"> & { image?: string };
  costUsd?: number;
  error?: string;
}

/** A finished job, kept in history (no image data). */
export type JobRecord = Omit<JobView, "output" | "progress"> & {
  output?: Omit<HandlerOutput, "images">;
};

export interface EndpointView {
  id: string;
  name?: string;
  image?: string;
  gpuPools: string[];
  gpuTypes: string[];
  excludedTypes: string[];
  workersMin?: number;
  workersMax?: number;
  idleTimeoutS?: number;
  flashboot?: string;
  scaling?: { type?: string; queueDelay?: number };
  executionTimeoutMs?: number;
  health: {
    workers: Record<string, number>;
    jobs: Record<string, number>;
  } | null;
  fetchedAt: number;
}

export interface HistoryView {
  jobs: JobRecord[];
  stats: {
    completed: number;
    failed: number;
    cold: number;
    warmExecP50Ms: number | null;
    warmExecP90Ms: number | null;
    coldDelayP50Ms: number | null;
    avgCostUsd: number | null;
    totalCostUsd: number;
  };
  limits: {
    dailyCap: number;
    usedToday: number;
    maxSide: number;
    maxSteps: number;
    bulkMax: number;
    perIpPer10Min: number;
    videoEnabled: boolean;
    videoModels: VideoModel[];
    videoDailyCap: number;
    videoUsedToday: number;
  };
  pricesChecked: string;
}

/** An image or clip saved in the media library (the file itself is served by /api/media/[id]). */
export interface MediaItem {
  id: string;
  /** Missing on items saved before videos existed: treat as "image". */
  kind?: "image" | "video";
  mime?: string;
  /** For videos: the library image it was animated from, and its length. */
  sourceId?: string;
  durationS?: number;
  /** For videos: the model that made it (missing on clips saved before this was recorded). */
  model?: VideoModel;
  createdAt: number;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed?: number;
  gpu?: string;
  executionMs?: number;
  costUsd?: number;
  bytes?: number;
}

export interface MediaView {
  items: MediaItem[];
  usage: { count: number; bytes: number; persistent: boolean };
  videoEnabled: boolean;
  videoModels: VideoModel[];
  /** Video jobs still in flight, then ones that failed in the last few hours; newest first. */
  videoJobs: VideoJobView[];
}

// --------------------------------------------------------------------------- //
//                                   Video                                     //
// --------------------------------------------------------------------------- //
export type VideoModel = "wan22" | "ltx2";

export interface AnimateInput {
  /** Missing on jobs from before Wan existed: those ran on LTX-2.5. */
  model?: VideoModel;
  sourceId: string; // library image to animate
  prompt: string; // motion description
  resolution: "540p" | "720p";
  num_frames: number; // 8k+1; 49 ≈ 2 s, 121 ≈ 5 s at 24 fps
  audio: boolean;
  seed?: number;
}

/** The `worker` block of workers/video/handler.py (same shape as the image worker's). */
export type VideoWorkerInfo = WorkerInfo;

export interface VideoJobView {
  id: string;
  status: JobStatus;
  submittedAt: number;
  input: AnimateInput;
  sourcePrompt?: string;
  progress?: { step: number; total_steps: number };
  delayMs?: number;
  executionMs?: number;
  clientWallMs?: number;
  output?: {
    mediaId: string;
    url: string;
    bytes: number;
    seed: number;
    timings: { inference_ms: number; encode_ms: number; total_ms: number };
    worker?: VideoWorkerInfo;
    params: Record<string, unknown>;
  };
  costUsd?: number;
  error?: string;
}

// --------------------------------------------------------------------------- //
//                                   LoRA                                      //
// --------------------------------------------------------------------------- //
export interface LoraView {
  id: string;
  name: string;
  /** Word the captions started with; put it in a prompt to invoke the LoRA. */
  trigger: string;
  status: "training" | "ready" | "failed";
  createdAt: number;
  imageIds: string[];
  steps: number;
  rank: number;
  resolution: number;
  jobId?: string;
  progress?: { step: number; total_steps: number; loss?: number };
  delayMs?: number;
  executionMs?: number;
  gpu?: string;
  costUsd?: number;
  finalLoss?: number;
  timings?: Record<string, number>;
  bytes?: number;
  error?: string;
}

export interface LorasView {
  loras: LoraView[];
  enabled: boolean;
  limits: { minImages: number; maxImages: number; minSteps: number; maxSteps: number; dailyCap: number };
  presets: Record<"quick" | "standard" | "strong", number>;
}
