import "server-only";

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config";
import type { AnimateInput, VideoJobView } from "./types";

// Video jobs, kept apart from image jobs: different endpoint, different cap, and
// long-running (minutes), so mixing them into the image history would skew its
// latency stats. Same pattern as store.ts: memory + append-only JSONL on DATA_DIR.
// Submitted jobs are logged too, so a clip still in flight survives an app restart.

const file = config.dataDir ? join(config.dataDir, "video-jobs.jsonl") : "";
const pendingFile = config.dataDir ? join(config.dataDir, "video-pending.jsonl") : "";

interface Pending {
  input: AnimateInput;
  sourcePrompt?: string;
  submittedAt: number;
}

const g = globalThis as unknown as {
  __fluxVideo?: { pending: Map<string, Pending>; done: Map<string, VideoJobView> };
};

function readLines<T>(path: string): T[] {
  if (!path || !existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip a torn last line
    }
  }
  return out;
}

function append(path: string, record: unknown) {
  if (!path) return;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch (e) {
    console.error(`could not persist video jobs to ${path}`, e);
  }
}

function load() {
  const done = new Map<string, VideoJobView>();
  for (const r of readLines<VideoJobView>(file)) done.set(r.id, r);
  const pending = new Map<string, Pending>();
  for (const { id, ...p } of readLines<Pending & { id: string }>(pendingFile)) if (!done.has(id)) pending.set(id, p);
  return { pending, done };
}

const store = (g.__fluxVideo ??= load());

export function addVideoPending(id: string, input: AnimateInput, sourcePrompt?: string) {
  const p = { input, sourcePrompt, submittedAt: Date.now() };
  store.pending.set(id, p);
  append(pendingFile, { id, ...p });
}

export const getVideoPending = (id: string) => store.pending.get(id);
export const getVideoRecord = (id: string) => store.done.get(id);
export const isVideoKnown = (id: string) => store.pending.has(id) || store.done.has(id);
export const activeVideoCount = () => store.pending.size;

/** In-flight jobs, newest first. */
export function pendingVideos(): (Pending & { id: string })[] {
  return [...store.pending].map(([id, p]) => ({ id, ...p })).sort((a, b) => b.submittedAt - a.submittedAt);
}

export function finishVideo(record: VideoJobView) {
  if (store.done.has(record.id)) return;
  store.pending.delete(record.id);
  store.done.set(record.id, record);
  append(file, record);
}

export function videoHistory(): VideoJobView[] {
  return [...store.done.values()].sort((a, b) => b.submittedAt - a.submittedAt);
}

/** Jobs submitted since `ts` that ended without a clip, newest first. */
export function failedVideosSince(ts: number): VideoJobView[] {
  return videoHistory().filter((r) => r.submittedAt >= ts && (r.status !== "COMPLETED" || !!r.error));
}

// Clips that passed checkVideoAccess but aren't recorded yet; see reserveImages in store.ts.
let inFlight = 0;

/** Holds one clip slot until the job is recorded with addVideoPending (or failed); returns release(). */
export function reserveVideo(): () => void {
  inFlight += 1;
  let open = true;
  return () => {
    if (open) inFlight -= 1;
    open = false;
  };
}

export function videosSubmittedSince(ts: number): number {
  let n = inFlight;
  for (const p of store.pending.values()) if (p.submittedAt >= ts) n++;
  for (const r of store.done.values()) if (r.submittedAt >= ts) n++;
  return n;
}
