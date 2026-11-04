import "server-only";

import { config, requireRunpod } from "./config";
import type { GenerateInput, JobStatus } from "./types";

// Serverless job API (queue-based endpoints).
const JOBS_API = "https://api.runpod.ai/v2";
// REST v2 management API: endpoint config (GPU pools, workers, scaling).
const MGMT_API = "https://api.runpod.io/v2";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  requireRunpod();
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    // Never echo request headers; the body from Runpod is safe to surface.
    throw new Error(`Runpod ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface RunpodStatus {
  id: string;
  status: JobStatus;
  delayTime?: number;
  executionTime?: number;
  workerId?: string;
  output?: unknown;
  error?: string;
}

/** `lora` here is what handler.py reads: the adapter's id, a URL to fetch it from, and its scale. */
export function submitJob(input: Omit<GenerateInput, "lora">, lora?: { id: string; url: string; scale: number }) {
  // JPEG keeps the browser payload small (a 1024² PNG is ~1.5 MB of base64).
  return call<{ id: string; status: JobStatus }>(`${JOBS_API}/${config.endpointId}/run`, {
    method: "POST",
    body: JSON.stringify({ input: { ...input, image_format: "jpeg", ...(lora ? { lora } : {}) } }),
  });
}

/** A LoRA training job on the training endpoint (handler.py task "train_lora"). */
export function submitTrainJob(input: Record<string, unknown>) {
  return call<{ id: string; status: JobStatus }>(`${JOBS_API}/${config.trainEndpointId}/run`, { method: "POST", body: JSON.stringify({ input }) });
}

export function trainJobStatus(id: string) {
  return call<RunpodStatus>(`${JOBS_API}/${config.trainEndpointId}/status/${encodeURIComponent(id)}`);
}

export function jobStatus(id: string) {
  return call<RunpodStatus>(`${JOBS_API}/${config.endpointId}/status/${encodeURIComponent(id)}`);
}

export function endpointHealth(endpointId = config.endpointId) {
  return call<{ workers: Record<string, number>; jobs: Record<string, number> }>(`${JOBS_API}/${endpointId}/health`);
}

export interface EndpointConfig {
  id: string;
  name?: string;
  image?: string;
  gpu?: { pools?: string[]; excludedTypes?: string[] };
  workers?: { min?: number; max?: number; idleTimeout?: number };
  scaling?: { type?: string; queueDelay?: number };
  flashboot?: string;
  timeout?: number;
}

export function endpointConfig(endpointId = config.endpointId) {
  return call<EndpointConfig>(`${MGMT_API}/serverless/${endpointId}`);
}

// --------------------------------------------------------------------------- //
//                         Image-to-video (LTX-2.5) endpoint                   //
// --------------------------------------------------------------------------- //
export interface VideoJobInput {
  image: string; // data URI of a library image
  prompt: string;
  resolution: "540p" | "720p";
  num_frames: number;
  audio: boolean;
  seed?: number;
}

export function submitVideoJob(endpointId: string, input: VideoJobInput) {
  return call<{ id: string; status: JobStatus }>(`${JOBS_API}/${endpointId}/run`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
}

export function videoJobStatus(endpointId: string, id: string) {
  return call<RunpodStatus>(`${JOBS_API}/${endpointId}/status/${encodeURIComponent(id)}`);
}

export interface GpuCatalogEntry {
  id: string;
  pool?: string | null;
}

export function gpuCatalog() {
  return call<GpuCatalogEntry[] | { gpus?: GpuCatalogEntry[] }>(`${MGMT_API}/catalog/gpus`);
}
