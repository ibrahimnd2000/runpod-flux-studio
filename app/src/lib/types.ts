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
  limits: { dailyCap: number; usedToday: number; maxSide: number; maxSteps: number };
  pricesChecked: string;
}
