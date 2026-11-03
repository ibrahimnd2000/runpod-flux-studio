import "server-only";

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config";
import type { MediaItem } from "./types";

// Media library: every completed image is saved as DATA_DIR/images/<jobId>.jpg
// (the pod's network volume), indexed in DATA_DIR/media.jsonl. The index is
// append-only; a deletion is a tombstone line, so the last line per id wins.
// Without DATA_DIR (local dev) images are kept in memory, newest 50 only.

const MEMORY_MAX = 50;
const dir = config.dataDir ? join(config.dataDir, "images") : "";
const indexFile = config.dataDir ? join(config.dataDir, "media.jsonl") : "";

// Runpod job ids are UUID-like (with an "-e2"-style suffix). Anything else is
// rejected before it can become part of a file path.
const ID_RE = /^[A-Za-z0-9-]{8,80}$/;
export const isValidId = (id: string) => ID_RE.test(id);

type Entry = MediaItem | { id: string; deleted: true };

const g = globalThis as unknown as {
  __fluxMedia?: { items: Map<string, MediaItem>; memory: Map<string, Buffer> };
};

function load() {
  const items = new Map<string, MediaItem>();
  if (indexFile && existsSync(indexFile)) {
    for (const line of readFileSync(indexFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Entry;
        if ("deleted" in e) items.delete(e.id);
        else items.set(e.id, e);
      } catch {
        // skip a torn last line
      }
    }
  }
  return { items, memory: new Map<string, Buffer>() };
}

const media = (g.__fluxMedia ??= load());

function append(entry: Entry) {
  if (!indexFile) return;
  mkdirSync(config.dataDir, { recursive: true });
  appendFileSync(indexFile, JSON.stringify(entry) + "\n");
}

/** Saves a completed job's image. Failures are logged, never thrown: a missing library copy must not fail the job. */
export function saveImage(item: MediaItem, base64Jpeg: string) {
  if (!isValidId(item.id) || media.items.has(item.id)) return;
  const bytes = Buffer.from(base64Jpeg, "base64");
  try {
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${item.id}.jpg`), bytes);
    } else {
      media.memory.set(item.id, bytes);
      while (media.memory.size > MEMORY_MAX) {
        const oldest = media.memory.keys().next().value!;
        media.memory.delete(oldest);
        media.items.delete(oldest);
      }
    }
    const saved = { ...item, bytes: bytes.length };
    media.items.set(item.id, saved);
    append(saved);
  } catch (e) {
    console.error(`could not save image ${item.id} to the media library`, e);
  }
}

export function listMedia(): MediaItem[] {
  return [...media.items.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function readImage(id: string): Buffer | null {
  if (!isValidId(id) || !media.items.has(id)) return null;
  if (!dir) return media.memory.get(id) ?? null;
  const path = join(dir, `${id}.jpg`);
  return existsSync(path) ? readFileSync(path) : null;
}

/** Deletes the image file and tombstones its index entry. Returns false if it didn't exist. */
export function deleteImage(id: string): boolean {
  if (!isValidId(id) || !media.items.has(id)) return false;
  if (dir) {
    const path = join(dir, `${id}.jpg`);
    if (existsSync(path)) unlinkSync(path);
  } else {
    media.memory.delete(id);
  }
  media.items.delete(id);
  append({ id, deleted: true });
  return true;
}

export function mediaUsage() {
  const items = [...media.items.values()];
  return { count: items.length, bytes: items.reduce((a, i) => a + (i.bytes ?? 0), 0), persistent: !!dir };
}
