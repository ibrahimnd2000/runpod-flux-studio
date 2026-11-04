import "server-only";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config";
import { LimitError, startOfUtcDay } from "./limits";
import { getMediaItem, isDryRunMedia } from "./media";
import { requestCost } from "./prices";
import { submitJob, submitTrainJob, trainJobStatus } from "./runpod";
import { TERMINAL, type GenerateInput, type LoraView } from "./types";

// LoRA fine-tunes of FLUX.1-dev. The training endpoint (same worker image,
// task "train_lora") downloads the chosen library images from this app, trains,
// and PUTs the adapter back here with a one-time token; the image endpoint then
// downloads it by URL when a job names it. Records live in DATA_DIR/loras.jsonl
// (last line per id wins), files in DATA_DIR/loras/<id>.safetensors. Without
// DATA_DIR (local dev) both stay in memory.

export const LORA_LIMITS = { minImages: 4, maxImages: 40, minSteps: 100, maxSteps: 2000, maxBytes: 200 * 2 ** 20 } as const;
export const STEP_PRESETS = { quick: 400, standard: 800, strong: 1500 } as const;
const ID_RE = /^lora_[a-f0-9]{12}$/;
const GIVE_UP_MS = 3 * 60 * 60_000;
const TRIGGER_RE = /^[a-z][a-z0-9_]{2,23}$/;

type Record_ = LoraView & { tokenHash?: string };

const dir = config.dataDir ? join(config.dataDir, "loras") : "";
const indexFile = config.dataDir ? join(config.dataDir, "loras.jsonl") : "";

const g = globalThis as unknown as { __fluxLoras?: { items: Map<string, Record_>; memory: Map<string, Buffer> } };

function load() {
  const items = new Map<string, Record_>();
  if (indexFile && existsSync(indexFile)) {
    for (const line of readFileSync(indexFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Record_ | { id: string; deleted: true };
        if ("deleted" in r) items.delete(r.id);
        else items.set(r.id, r);
      } catch {
        // skip a torn last line
      }
    }
  }
  return { items, memory: new Map<string, Buffer>() };
}

const store = (g.__fluxLoras ??= load());

function save(r: Record_ | { id: string; deleted: true }) {
  if ("deleted" in r) store.items.delete(r.id);
  else store.items.set(r.id, r);
  if (!indexFile) return;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    appendFileSync(indexFile, JSON.stringify(r) + "\n");
  } catch (e) {
    console.error(`could not persist LoRA ${r.id}`, e);
  }
}

function view(r: Record_): LoraView {
  const v: Record_ = { ...r };
  delete v.tokenHash; // never leaves the server
  return v;
}
const hash = (token: string) => createHash("sha256").update(token).digest();
export const isLoraId = (id: string) => ID_RE.test(id);

/** The URL other services (the GPU workers) reach this app at. */
export function publicUrl(): string {
  if (process.env.APP_PUBLIC_URL) return process.env.APP_PUBLIC_URL.replace(/\/$/, "");
  // Runpod sets RUNPOD_POD_ID on pods; port 3000 is the app's HTTP proxy port.
  return process.env.RUNPOD_POD_ID ? `https://${process.env.RUNPOD_POD_ID}-3000.proxy.runpod.net` : "";
}

export const trainingEnabled = () => !!(config.apiKey && config.trainEndpointId && publicUrl());

export const getLora = (id: string) => (isLoraId(id) ? store.items.get(id) : undefined);
export const listLoras = (): LoraView[] => [...store.items.values()].sort((a, b) => b.createdAt - a.createdAt).map(view);

export interface TrainRequest {
  name: string;
  trigger: string;
  imageIds: string[];
  steps: number;
}

export function parseTrainRequest(body: Record<string, unknown>): TrainRequest {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) throw new LimitError("Give the LoRA a name.", 400);
  const trigger = typeof body.trigger === "string" ? body.trigger.trim().toLowerCase() : "";
  if (!TRIGGER_RE.test(trigger)) throw new LimitError("The trigger word must be 3-24 lowercase letters, digits or _, starting with a letter (e.g. zxq_mug).", 400);
  const ids = Array.isArray(body.imageIds) ? [...new Set(body.imageIds.filter((x): x is string => typeof x === "string"))] : [];
  if (ids.length < LORA_LIMITS.minImages || ids.length > LORA_LIMITS.maxImages)
    throw new LimitError(`Pick ${LORA_LIMITS.minImages}-${LORA_LIMITS.maxImages} images to train on.`, 400);
  for (const id of ids) {
    const item = getMediaItem(id);
    if (!item || (item.kind ?? "image") !== "image" || isDryRunMedia(id)) throw new LimitError(`${id} isn't an image in the library.`, 400);
  }
  const raw = Number(body.steps);
  const steps = Number.isFinite(raw) ? Math.round(Math.min(Math.max(raw, LORA_LIMITS.minSteps), LORA_LIMITS.maxSteps)) : STEP_PRESETS.standard;
  return { name, trigger, imageIds: ids, steps };
}

/** One training at a time and a small daily cap: each run holds a GPU for ~10-30 minutes. */
function checkTrainingLimits() {
  if (!trainingEnabled()) throw new LimitError("Fine-tuning isn't enabled on this deployment.", 503);
  const all = [...store.items.values()];
  if (all.some((r) => r.status === "training")) throw new LimitError("A LoRA is already training; wait for it to finish.", 429);
  const today = all.filter((r) => r.createdAt >= startOfUtcDay()).length;
  if (today >= config.loraDailyCap) throw new LimitError(`Daily cap of ${config.loraDailyCap} trainings reached; resets 00:00 UTC.`, 429);
}

/** Submits a training job; captions are the trigger word plus each image's prompt. */
export async function startTraining(req: TrainRequest): Promise<LoraView> {
  checkTrainingLimits();
  const id = `lora_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const token = randomBytes(24).toString("hex");
  const base = publicUrl();
  const images = req.imageIds.map((mid) => ({ url: `${base}/api/media/${mid}`, caption: `${req.trigger}, ${getMediaItem(mid)!.prompt}` }));
  const job = await submitTrainJob({ task: "train_lora", images, steps: req.steps, rank: 16, resolution: 512, upload_url: `${base}/api/loras/${id}/file`, upload_token: token });
  const r: Record_ = {
    id,
    name: req.name,
    trigger: req.trigger,
    status: "training",
    createdAt: Date.now(),
    imageIds: req.imageIds,
    steps: req.steps,
    rank: 16,
    resolution: 512,
    jobId: job.id,
    tokenHash: hash(token).toString("hex"),
  };
  save(r);
  return view(r);
}

interface TrainOutput {
  lora?: { bytes: number; sha256: string };
  final_loss?: number;
  timings?: Record<string, number>;
  worker?: { gpu?: string; peak_vram_gb?: number };
  error?: string;
}

/** Checks Runpod for a training LoRA and records the outcome once it ends. */
export async function refreshLora(id: string): Promise<LoraView | null> {
  const r = getLora(id);
  if (!r) return null;
  if (r.status !== "training" || !r.jobId) return view(r);
  let s: Awaited<ReturnType<typeof trainJobStatus>>;
  try {
    s = await trainJobStatus(r.jobId);
  } catch (e) {
    // Runpod keeps a finished job's result only for a while; don't let a LoRA
    // nobody watched stay "training" (and block new ones) forever.
    if (Date.now() - r.createdAt < GIVE_UP_MS) throw e;
    const ready = hasFile(id);
    const next: Record_ = { ...r, status: ready ? "ready" : "failed", tokenHash: undefined, progress: undefined, ...(ready ? {} : { error: "Lost track of the training job." }) };
    save(next);
    return view(next);
  }
  const next: Record_ = { ...r, jobStatus: s.status, delayMs: s.delayTime, executionMs: s.executionTime };
  if (s.status === "IN_PROGRESS" && s.output && typeof s.output === "object" && "step" in s.output) next.progress = s.output as LoraView["progress"];
  if (!TERMINAL.includes(s.status)) {
    store.items.set(id, next); // progress only: not worth a line in the index
    return view(next);
  }
  const out = (s.output ?? {}) as TrainOutput;
  next.progress = undefined;
  next.jobStatus = undefined;
  next.tokenHash = undefined; // the upload window is over either way
  next.gpu = out.worker?.gpu;
  next.costUsd = requestCost(out.worker?.gpu, s.executionTime);
  next.finalLoss = out.final_loss;
  next.timings = out.timings;
  const error = s.error || out.error;
  if (s.status === "COMPLETED" && !error && hasFile(id)) next.status = "ready";
  else {
    next.status = "failed";
    next.error = error || (s.status === "COMPLETED" ? "Training finished but the adapter never arrived." : `The training job ${s.status.toLowerCase()}.`);
  }
  save(next);
  return view(next);
}

/** Refreshes every training LoRA (the list page polls this). */
export async function syncLoras(): Promise<LoraView[]> {
  const training = [...store.items.values()].filter((r) => r.status === "training");
  await Promise.allSettled(training.map((r) => refreshLora(r.id)));
  return listLoras();
}

const fileFor = (id: string) => join(dir, `${id}.safetensors`);
const hasFile = (id: string) => (dir ? existsSync(fileFor(id)) : store.memory.has(id));

/** The training worker's upload. Accepted once, only with the job's token, only while training. */
export function acceptUpload(id: string, token: string | null, bytes: Buffer): void {
  const r = getLora(id);
  if (!r || r.status !== "training" || !r.tokenHash || !token) throw new LimitError("Upload not accepted.", 403);
  const want = Buffer.from(r.tokenHash, "hex");
  const got = hash(token);
  if (!timingSafeEqual(want, got)) throw new LimitError("Upload not accepted.", 403);
  if (bytes.length === 0 || bytes.length > LORA_LIMITS.maxBytes) throw new LimitError("The adapter file is empty or too large.", 413);
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(fileFor(id), bytes);
  } else store.memory.set(id, bytes);
  save({ ...r, bytes: bytes.length, tokenHash: undefined });
}

export function readLoraFile(id: string): Buffer | null {
  const r = getLora(id);
  if (!r || r.status !== "ready") return null;
  if (!dir) return store.memory.get(id) ?? null;
  return existsSync(fileFor(id)) ? readFileSync(fileFor(id)) : null;
}

export function deleteLora(id: string): boolean {
  const r = getLora(id);
  if (!r) return false;
  if (r.status === "training") throw new LimitError("This LoRA is still training.", 409);
  if (dir && existsSync(fileFor(id))) unlinkSync(fileFor(id));
  store.memory.delete(id);
  save({ id, deleted: true });
  return true;
}

/** Submits an image job, turning `lora: {id, scale}` into what the worker fetches. */
export function submitImage(input: GenerateInput) {
  const { lora, ...rest } = input;
  return submitJob(rest, lora ? loraForJob(lora) : undefined);
}

/** What the image worker needs to apply a ready LoRA (handler.py `lora` input). */
export function loraForJob(spec: { id: string; scale: number }) {
  const r = getLora(spec.id);
  if (!r || r.status !== "ready") throw new LimitError("That LoRA isn't ready (or no longer exists).", 400);
  return { id: r.id, url: `${publicUrl()}/api/loras/${r.id}/file`, scale: spec.scale };
}
