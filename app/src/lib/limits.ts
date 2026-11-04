import "server-only";

import { timingSafeEqual } from "node:crypto";

import { config, videoModels } from "./config";
import { submittedByIpSince, submittedSince } from "./store";
import type { AnimateInput, GenerateInput } from "./types";
import { videosSubmittedSince } from "./videoStore";

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

/** The JSON body of a request; a malformed or missing body is the caller's mistake (400), not ours. */
export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as T;
  } catch {
    throw new LimitError("The request body must be a JSON object.", 400);
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
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

/** Checks the access code and that `count` more images fit in the daily cap and the visitor's rate limit. */
export function checkAccess(code: string | null, ip: string, count = 1) {
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
}

/** Video: access code, its own daily cap (clips cost ~10x an image) and the shared per-visitor rate limit. */
export function checkVideoAccess(code: string | null, ip: string) {
  if (!videoModels().length) throw new LimitError("Video generation isn't enabled on this deployment.", 503);
  checkCode(code);
  const used = videosSubmittedSince(startOfUtcDay());
  if (used >= config.videoDailyCap)
    throw new LimitError(`Daily demo cap of ${config.videoDailyCap} videos reached; resets at 00:00 UTC.`, 429);
  if (submittedByIpSince(ip, Date.now() - 10 * 60_000) >= config.perIpPer10Min)
    throw new LimitError(`Rate limit: ${config.perIpPer10Min} jobs per 10 minutes per visitor.`, 429);
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
    audio: body.audio !== false,
  };
  if (body.seed !== undefined && body.seed !== null && body.seed !== "") input.seed = clamp(body.seed, 0, 2 ** 32 - 1, 0);
  return input;
}
