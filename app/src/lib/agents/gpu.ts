import "server-only";

import { randomUUID } from "node:crypto";

import { config, videoModels } from "../config";
import { refreshImageJob } from "../imageJobs";
import { checkAccess, checkVideoAccess, LimitError, sanitizeAnimate, sanitizeInput } from "../limits";
import { submitImage } from "../loras";
import { getMediaItem, readMedia, saveMedia } from "../media";
import { submitVideoJob } from "../runpod";
import { addPending, noteIp } from "../store";
import { TERMINAL } from "../types";
import { refreshVideoJob } from "../videoJobs";
import { addVideoPending } from "../videoStore";
import mock from "./mock-media.json";

// The GPU side of pipelines and agents: the same Runpod endpoints, limits and
// media library as the Studio, but awaited to completion so a step or a tool call
// gets a finished image. In a dry run nothing reaches Runpod: placeholder media is
// saved instead and priced at the measured averages below, so budgets behave the
// same way.

// Measured (README, bench/results): FLUX.1-dev 1024², 28 steps, warm, RTX 6000 Ada;
// Wan 2.2 2 s clip, RTX 6000 Ada. Used for estimates and dry-run pricing.
export const MEASURED = {
  imageUsd: 0.0107,
  imageWarmS: 21.9,
  imageColdS: 93.3, // cached host, no FlashBoot
  videoUsdPerS: 0.021,
  videoExecSPerS: 43.6,
};

export interface GpuCtx {
  code: string | null;
  ip: string;
  dryRun: boolean;
  aborted: () => boolean;
}

export interface ImageResult {
  mediaId?: string;
  prompt: string;
  seed?: number;
  gpu?: string;
  executionMs?: number;
  delayMs?: number;
  costUsd: number;
  error?: string;
}

export interface VideoResult {
  mediaId?: string;
  sourceId: string;
  model?: string;
  executionMs?: number;
  delayMs?: number;
  costUsd: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Dry runs pause like a (very fast) GPU so the UI shows progress; tests set 0.
const dryDelay = (ms: number) => sleep(ms * (Number(process.env.DRY_RUN_DELAY_SCALE ?? 1) || 0));

async function waitFor<T extends { status: string }>(
  ctx: GpuCtx,
  poll: () => Promise<T | null>,
  everyMs: number,
  timeoutMs: number,
): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v: T | null = null;
    try {
      v = await poll();
    } catch (e) {
      // A transient status failure must not lose the job; try again next tick.
      console.error("status poll failed", e);
    }
    if (v && TERMINAL.includes(v.status as never)) return v;
    if (Date.now() > end || ctx.aborted()) return v;
    await sleep(everyMs);
  }
}

/** Generates one image per prompt, in parallel (one Runpod job each), and waits for all of them. */
export async function generateImages(
  ctx: GpuCtx,
  prompts: string[],
  opts: { width?: number; height?: number; steps?: number } = {},
): Promise<ImageResult[]> {
  const inputs = prompts.map((prompt) =>
    sanitizeInput({ prompt, width: opts.width ?? 1024, height: opts.height ?? 1024, num_inference_steps: opts.steps ?? 28 }),
  );

  if (ctx.dryRun) {
    const offset = (Math.random() * mock.images.length) | 0;
    return Promise.all(
      inputs.map(async (input, i) => {
        await dryDelay(1200 + Math.random() * 1800);
        const id = `dry-${randomUUID()}`;
        const costUsd = MEASURED.imageUsd * (input.num_inference_steps / 28) * ((input.width * input.height) / 1024 ** 2);
        saveMedia(
          { id, kind: "image", createdAt: Date.now(), prompt: input.prompt, width: 256, height: 256, steps: 0, costUsd },
          mock.images[(offset + i) % mock.images.length],
        );
        return { mediaId: id, prompt: input.prompt, costUsd, executionMs: 0, gpu: "dry run" };
      }),
    );
  }

  checkAccess(ctx.code, ctx.ip, inputs.length);
  const base = Math.floor(Math.random() * 2 ** 31);
  return Promise.all(
    inputs.map(async (input, i): Promise<ImageResult> => {
      input.seed = base + i;
      let id: string;
      try {
        id = (await submitImage(input)).id;
      } catch (e) {
        console.error("agent image submit failed", e);
        return { prompt: input.prompt, costUsd: 0, error: "Could not submit the job to Runpod." };
      }
      addPending(id, input, ctx.ip);
      noteIp(ctx.ip);
      const v = await waitFor(ctx, () => refreshImageJob(id), 2000, 20 * 60_000);
      if (!v || v.status !== "COMPLETED")
        return { prompt: input.prompt, costUsd: v?.costUsd ?? 0, error: v?.error ?? `Job ${v?.status ?? "timed out"}.` };
      return {
        mediaId: id,
        prompt: input.prompt,
        seed: v.output?.seed,
        gpu: v.output?.worker?.gpu,
        executionMs: v.executionMs,
        delayMs: v.delayMs,
        costUsd: v.costUsd ?? 0,
      };
    }),
  );
}

export const videoAvailable = () => videoModels().length > 0;

/** Animates a library image with the fastest configured video model and waits for the clip. */
export async function animateImage(ctx: GpuCtx, sourceId: string, motion: string, seconds: 2 | 3 | 5): Promise<VideoResult> {
  const source = getMediaItem(sourceId);
  if (!source || (source.kind ?? "image") !== "image") throw new LimitError(`No library image with id ${sourceId}.`, 404);
  const frames = { 2: 49, 3: 73, 5: 121 }[seconds];

  if (ctx.dryRun) {
    await dryDelay(2500 + Math.random() * 2000);
    const id = `dry-${randomUUID()}`;
    const costUsd = MEASURED.videoUsdPerS * seconds;
    saveMedia(
      { id, kind: "video", createdAt: Date.now(), prompt: motion, sourceId, width: 128, height: 128, steps: 0, costUsd, durationS: seconds },
      mock.video,
    );
    return { mediaId: id, sourceId, model: "dry run", costUsd, executionMs: 0 };
  }

  if (!videoAvailable()) throw new LimitError("Video generation isn't enabled on this deployment.", 503);
  checkVideoAccess(ctx.code, ctx.ip);
  const input = sanitizeAnimate({ sourceId, prompt: motion, num_frames: frames, resolution: "540p", audio: false });
  const file = readMedia(sourceId)!;
  const job = await submitVideoJob(config.videoEndpoints[input.model!], {
    image: `data:${file.mime};base64,${file.bytes.toString("base64")}`,
    prompt: input.prompt,
    resolution: input.resolution,
    num_frames: input.num_frames,
    audio: false,
  });
  addVideoPending(job.id, input, source.prompt);
  noteIp(ctx.ip);
  const v = await waitFor(ctx, () => refreshVideoJob(job.id), 4000, 40 * 60_000);
  if (!v || v.status !== "COMPLETED")
    return { sourceId, model: input.model, costUsd: v?.costUsd ?? 0, error: v?.error ?? `Job ${v?.status ?? "timed out"}.` };
  return {
    mediaId: v.output?.mediaId,
    sourceId,
    model: input.model,
    executionMs: v.executionMs,
    delayMs: v.delayMs,
    costUsd: v.costUsd ?? 0,
  };
}
