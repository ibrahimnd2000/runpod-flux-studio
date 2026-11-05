import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

// The stores keep everything in memory and append to JSONL files on DATA_DIR (a Runpod
// network volume in production). Every other test runs without DATA_DIR; this one writes
// real files, then "restarts" the app (fresh modules, empty in-memory caches) and reads
// them back, the way a pod restart would.

vi.mock("server-only", () => ({}));
const dir = mkdtempSync(join(tmpdir(), "flux-studio-"));
vi.stubEnv("DATA_DIR", dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const STORE_KEYS = ["__fluxStore", "__fluxMedia", "__fluxVideo", "__fluxLoras", "__fluxRuns"];

/** A new app process: modules re-evaluated and the globalThis caches gone. */
async function restart() {
  vi.resetModules();
  for (const k of STORE_KEYS) delete (globalThis as Record<string, unknown>)[k];
  return {
    media: await import("@/lib/media"),
    store: await import("@/lib/store"),
    video: await import("@/lib/videoStore"),
    limits: await import("@/lib/limits"),
  };
}

const JPEG = Buffer.from("fake-jpeg-bytes").toString("base64");
const item = (id: string) => ({ id, prompt: `prompt ${id}`, width: 1024, height: 1024, steps: 28, createdAt: Date.now() });

describe("persistence across restarts", () => {
  it("keeps library items and their files, honours deletions and skips a torn last line", async () => {
    let app = await restart();
    app.media.saveMedia(item("persist-a1"), JPEG);
    app.media.saveMedia(item("persist-b2"), JPEG);
    expect(app.media.deleteImage("persist-a1")).toBe(true);
    appendFileSync(join(dir, "media.jsonl"), '{"id":"persist-torn'); // a crash mid-write

    app = await restart();
    expect(app.media.getMediaItem("persist-a1")).toBeUndefined();
    expect(app.media.getMediaItem("persist-b2")?.prompt).toBe("prompt persist-b2");
    expect(app.media.readMedia("persist-b2")?.bytes.toString()).toBe("fake-jpeg-bytes");
  });

  it("keeps finished image jobs, so history and the daily cap survive a restart", async () => {
    let app = await restart();
    const input = app.limits.sanitizeInput({ prompt: "p" });
    app.store.addPending("persist-job-1", input, "1.1.1.1");
    app.store.finish({ id: "persist-job-1", status: "COMPLETED", submittedAt: Date.now(), input });

    app = await restart();
    expect(app.store.history().find((j) => j.id === "persist-job-1")?.status).toBe("COMPLETED");
    expect(app.store.submittedSince(0)).toBeGreaterThanOrEqual(1);
  });

  it("keeps video jobs that were still running, so the library can pick them up after a restart", async () => {
    let app = await restart();
    app.video.addVideoPending("persist-clip-1", { model: "wan22", sourceId: "persist-b2", prompt: "pan", resolution: "540p", num_frames: 49, audio: false });

    app = await restart();
    expect(app.video.pendingVideos().map((p) => p.id)).toContain("persist-clip-1");
  });
});
