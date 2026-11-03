import "server-only";

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config";
import type { GenerateInput, JobRecord } from "./types";

// Job history for the dashboard. In memory, mirrored to an append-only JSONL file
// when DATA_DIR is set (a Runpod pod volume), so it survives restarts.

const MAX_JOBS = 500;
const file = config.dataDir ? join(config.dataDir, "jobs.jsonl") : "";

interface Pending {
  input: GenerateInput;
  submittedAt: number;
  ip: string;
}

const g = globalThis as unknown as {
  __fluxStore?: { pending: Map<string, Pending>; done: Map<string, JobRecord> };
};

function load() {
  const done = new Map<string, JobRecord>();
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as JobRecord;
        done.set(r.id, r);
      } catch {
        // skip a torn last line
      }
    }
  }
  return { pending: new Map<string, Pending>(), done };
}

// Survives dev-server hot reloads.
const store = (g.__fluxStore ??= load());

export function addPending(id: string, input: GenerateInput, ip: string) {
  store.pending.set(id, { input, submittedAt: Date.now(), ip });
}

export function getPending(id: string) {
  return store.pending.get(id);
}

export function isKnown(id: string) {
  return store.pending.has(id) || store.done.has(id);
}

export function finish(record: JobRecord) {
  if (store.done.has(record.id)) return;
  store.pending.delete(record.id);
  store.done.set(record.id, record);
  while (store.done.size > MAX_JOBS) store.done.delete(store.done.keys().next().value!);
  if (file) {
    try {
      mkdirSync(config.dataDir, { recursive: true });
      appendFileSync(file, JSON.stringify(record) + "\n");
    } catch (e) {
      // History still works in memory; losing persistence must not fail the request.
      console.error(`could not persist job history to ${file}`, e);
    }
  }
}

export function getRecord(id: string) {
  return store.done.get(id);
}

export function history(): JobRecord[] {
  return [...store.done.values()].sort((a, b) => b.submittedAt - a.submittedAt);
}

export function submittedSince(ts: number): number {
  let n = 0;
  for (const p of store.pending.values()) if (p.submittedAt >= ts) n++;
  for (const r of store.done.values()) if (r.submittedAt >= ts) n++;
  return n;
}

// Submission times per IP, kept in memory only (IPs are never written to disk).
const ipLog = new Map<string, number[]>();

export function submittedByIpSince(ip: string, ts: number): number {
  return ipLog.get(ip)?.filter((t) => t >= ts).length ?? 0;
}

export function noteIp(ip: string) {
  const cutoff = Date.now() - 24 * 3600_000;
  ipLog.set(ip, [...(ipLog.get(ip) ?? []).filter((t) => t >= cutoff), Date.now()]);
}
