import "server-only";

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config";
import type { AnimateInput, VideoJobView } from "./types";

// Video jobs, kept apart from image jobs: different endpoint, different cap, and
// long-running (minutes), so mixing them into the image history would skew its
// latency stats. Same pattern as store.ts: memory + append-only JSONL on DATA_DIR.

const file = config.dataDir ? join(config.dataDir, "video-jobs.jsonl") : "";

interface Pending {
  input: AnimateInput;
  sourcePrompt?: string;
  submittedAt: number;
}

const g = globalThis as unknown as {
  __fluxVideo?: { pending: Map<string, Pending>; done: Map<string, VideoJobView> };
};

function load() {
  const done = new Map<string, VideoJobView>();
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as VideoJobView;
        done.set(r.id, r);
      } catch {
        // skip a torn last line
      }
    }
  }
  return { pending: new Map<string, Pending>(), done };
}

const store = (g.__fluxVideo ??= load());

export function addVideoPending(id: string, input: AnimateInput, sourcePrompt?: string) {
  store.pending.set(id, { input, sourcePrompt, submittedAt: Date.now() });
}

export const getVideoPending = (id: string) => store.pending.get(id);
export const getVideoRecord = (id: string) => store.done.get(id);
export const isVideoKnown = (id: string) => store.pending.has(id) || store.done.has(id);
export const pendingVideoIds = () => [...store.pending.keys()];

export function finishVideo(record: VideoJobView) {
  if (store.done.has(record.id)) return;
  store.pending.delete(record.id);
  store.done.set(record.id, record);
  if (file) {
    try {
      mkdirSync(config.dataDir, { recursive: true });
      appendFileSync(file, JSON.stringify(record) + "\n");
    } catch (e) {
      console.error(`could not persist video history to ${file}`, e);
    }
  }
}

export function videoHistory(): VideoJobView[] {
  return [...store.done.values()].sort((a, b) => b.submittedAt - a.submittedAt);
}

export function videosSubmittedSince(ts: number): number {
  let n = 0;
  for (const p of store.pending.values()) if (p.submittedAt >= ts) n++;
  for (const r of store.done.values()) if (r.submittedAt >= ts) n++;
  return n;
}
