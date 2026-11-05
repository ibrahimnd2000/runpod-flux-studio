import "server-only";

import { timingSafeEqual } from "node:crypto";

import { config, videoModels } from "./config";
import { noteIp, reserveImages, submittedByIpSince, submittedSince } from "./store";
import type { AnimateInput, GenerateInput } from "./types";
import { reserveVideo, videosSubmittedSince } from "./videoStore";

// Every Generate spends GPU credits, so the public demo is guarded by an access
// code, a per-IP rate limit, a daily job cap and tighter size/step limits than the
// endpoint itself allows (the worker still validates everything again).

export class LimitError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// Route handlers don't cap request bodies; the largest legitimate one (a pipeline spec) is a few KB.
const MAX_JSON_BYTES = 256 * 1024;

/** The JSON body of a request; a malformed, missing or oversized body is the caller's mistake (4xx), not ours. */
export async function readJson<T = unknown>(req: Request): Promise<T> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON_BYTES) throw new LimitError("The request body is too large.", 413);
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw new LimitError("The request body is too large.", 413);
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as T;
  } catch {
    throw new LimitError("The request body must be a JSON object.", 400);
  }
}

/**
 * The visitor's IP for rate limiting. Runpod's proxy sits behind Cloudflare, which sets
 * cf-connecting-ip itself (a client can't forge it); the first X-Forwarded-For entry is
 * whatever the client sent, so it's only the last resort.
 */
export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}

function codeMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(config.accessCode);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startOfUtcDay(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The access code alone: gates actions that change data but don't spend credits (e.g. deleting images). */
export function checkCode(code: string | null) {
  if (!config.accessCode) throw new LimitError("Changes are disabled on this deployment (no access code set).", 503);
  if (!code || !codeMatches(code)) throw new LimitError("Wrong or missing access code.", 401);
}

/**
 * Checks the access code and that `count` more images fit in the daily cap and the
 * visitor's rate limit, then reserves them (synchronously, so parallel requests can't
 * all pass). Call the returned release() after addPending, or when the submit fails.
 */
export function checkAccess(code: string | null, ip: string, count = 1): () => void {
  if (!config.accessCode) throw new LimitError("Generation is disabled on this deployment (no access code set).", 503);
  checkCode(code);
  const usedToday = submittedSince(startOfUtcDay());
  if (usedToday + count > config.dailyCap)
    throw new LimitError(
      `Daily demo cap of ${config.dailyCap} images: ${Math.max(config.dailyCap - usedToday, 0)} left today (resets 00:00 UTC).`,
      429,
    );
  const usedByIp = submittedByIpSince(ip, Date.now() - 10 * 60_000);
  if (usedByIp + count > config.perIpPer10Min)
    throw new LimitError(
      `Rate limit: ${config.perIpPer10Min} images per 10 minutes per visitor; ${Math.max(config.perIpPer10Min - usedByIp, 0)} available now.`,
      429,
    );
  return reserveImages(ip, count);
}

/** Video: access code, its own daily cap (clips cost ~10x an image) and the shared per-visitor rate limit.
 *  Reserves the clip like checkAccess does; call the returned release() after addVideoPending. */
export function checkVideoAccess(code: string | null, ip: string): () => void {
  if (!videoModels().length) throw new LimitError("Video generation isn't enabled on this deployment.", 503);
  checkCode(code);
  const used = videosSubmittedSince(startOfUtcDay());
  if (used >= config.videoDailyCap)
    throw new LimitError(`Daily demo cap of ${config.videoDailyCap} videos reached; resets at 00:00 UTC.`, 429);
  if (submittedByIpSince(ip, Date.now() - 10 * 60_000) >= config.perIpPer10Min)
    throw new LimitError(`Rate limit: ${config.perIpPer10Min} jobs per 10 minutes per visitor.`, 429);
  noteIp(ip);
  return reserveVideo();
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback;
};

export function sanitizeInput(body: Record<string, unknown>): GenerateInput {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 1000) : "";
  if (!prompt) throw new LimitError("Prompt is required.", 400);
  const side = (v: unknown) => Math.round(clamp(v, 256, config.maxSide, 1024) / 16) * 16;
  const input: GenerateInput = {
    prompt,
    width: side(body.width),
    height: side(body.height),
    num_inference_steps: clamp(body.num_inference_steps, 1, config.maxSteps, 28),
    guidance_scale: Math.min(Math.max(Number(body.guidance_scale) || 3.5, 0), 20),
  };
  if (body.seed !== undefined && body.seed !== null && body.seed !== "") {
    input.seed = clamp(body.seed, 0, 2 ** 32 - 1, 0);
  }
  // Shape only here; whether that LoRA exists and is ready is checked at submit (lib/loras.ts).
  const lora = body.lora as { id?: unknown; scale?: unknown } | null | undefined;
  if (lora && typeof lora === "object" && lora.id) {
    if (typeof lora.id !== "string" || !/^lora_[a-f0-9]{12}$/.test(lora.id)) throw new LimitError("Unknown LoRA.", 400);
    const scale = Number(lora.scale ?? 1);
    input.lora = { id: lora.id, scale: Number.isFinite(scale) ? Math.min(Math.max(Math.round(scale * 100) / 100, 0), 2) : 1 };
  }
  return input;
}

/** 8k+1 frames for LTX; snapped to the nearest valid count within the demo limit. */
export function sanitizeAnimate(body: Record<string, unknown>): AnimateInput {
  const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
  if (!sourceId) throw new LimitError("Pick an image from the library to animate.", 400);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 1000) : "";
  if (!prompt) throw new LimitError("Describe the motion, e.g. 'slow camera push-in, steam rising'.", 400);
  const frames = clamp(body.num_frames, 9, config.videoMaxFrames, 121);
  const available = videoModels();
  const model = available.includes(body.model as never) ? (body.model as AnimateInput["model"]) : available[0];
  const input: AnimateInput = {
    model,
    sourceId,
    prompt,
    resolution: body.resolution === "720p" ? "720p" : "540p",
    num_frames: Math.min(Math.round((frames - 1) / 8) * 8 + 1, config.videoMaxFrames),
    audio: model === "ltx2" && body.audio !== false, // Wan 2.2 is silent
  };
  if (body.seed !== undefined && body.seed !== null && body.seed !== "") input.seed = clamp(body.seed, 0, 2 ** 32 - 1, 0);
  return input;
}
