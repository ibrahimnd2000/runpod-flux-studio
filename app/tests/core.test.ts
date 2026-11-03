import { describe, expect, it } from "vitest";

import { checkAccess, checkCode, LimitError, sanitizeAnimate, sanitizeInput } from "@/lib/limits";
import { deleteImage, getMediaItem, isValidId, listMedia, mediaUsage, readMedia, saveMedia } from "@/lib/media";
import { pricePerHour, requestCost } from "@/lib/prices";
import { addPending, finish, history, isKnown, noteIp, submittedByIpSince, submittedSince } from "@/lib/store";

const JPEG = Buffer.from("fake-jpeg-bytes").toString("base64");

describe("sanitizeInput", () => {
  it("requires a prompt and trims it", () => {
    expect(() => sanitizeInput({ prompt: "   " })).toThrow(LimitError);
    expect(sanitizeInput({ prompt: "  a cat  " }).prompt).toBe("a cat");
  });

  it("caps the prompt at 1000 characters", () => {
    expect(sanitizeInput({ prompt: "x".repeat(5000) }).prompt).toHaveLength(1000);
  });

  it("clamps sizes to the demo limits and snaps them to multiples of 16", () => {
    const i = sanitizeInput({ prompt: "p", width: 5000, height: 100 });
    expect(i.width).toBe(1024);
    expect(i.height).toBe(256);
    expect(sanitizeInput({ prompt: "p", width: 1000 }).width % 16).toBe(0);
  });

  it("uses defaults for missing or invalid numbers", () => {
    const i = sanitizeInput({ prompt: "p", num_inference_steps: "lots", guidance_scale: "x" });
    expect(i).toMatchObject({ width: 1024, height: 1024, num_inference_steps: 28, guidance_scale: 3.5 });
    expect(i.seed).toBeUndefined();
  });

  it("caps steps and keeps an explicit seed", () => {
    const i = sanitizeInput({ prompt: "p", num_inference_steps: 100, seed: 42 });
    expect(i.num_inference_steps).toBe(28);
    expect(i.seed).toBe(42);
  });
});

describe("sanitizeAnimate", () => {
  it("needs a source image and a motion prompt", () => {
    expect(() => sanitizeAnimate({ prompt: "pan" })).toThrow(/library/);
    expect(() => sanitizeAnimate({ sourceId: "abcdefgh" })).toThrow(/motion/);
  });

  it("snaps frames to 8k+1 within the limit", () => {
    for (const asked of [9, 50, 73, 100, 121, 999]) {
      const { num_frames } = sanitizeAnimate({ sourceId: "abcdefgh", prompt: "pan", num_frames: asked });
      expect((num_frames - 1) % 8).toBe(0);
      expect(num_frames).toBeLessThanOrEqual(121);
    }
  });

  it("defaults to 540p with audio on", () => {
    expect(sanitizeAnimate({ sourceId: "abcdefgh", prompt: "pan" })).toMatchObject({ resolution: "540p", audio: true });
  });
});

describe("access checks", () => {
  it("rejects a missing or wrong code and accepts the right one", () => {
    expect(() => checkCode(null)).toThrow(LimitError);
    expect(() => checkCode("nope")).toThrow(/Wrong or missing/);
    expect(() => checkCode("test-code")).not.toThrow();
  });

  it("enforces the per-visitor rate limit", () => {
    const ip = "10.0.0.1";
    expect(() => checkAccess("test-code", ip, 12)).not.toThrow();
    for (let i = 0; i < 12; i++) noteIp(ip);
    expect(submittedByIpSince(ip, Date.now() - 60_000)).toBe(12);
    expect(() => checkAccess("test-code", ip, 1)).toThrow(/Rate limit/);
    expect(() => checkAccess("test-code", "10.0.0.2", 1)).not.toThrow();
  });

  it("enforces the daily cap", () => {
    expect(() => checkAccess("test-code", "10.0.0.3", 101)).toThrow(/Daily demo cap/);
  });
});

describe("job store", () => {
  it("tracks pending jobs and moves them to history once", () => {
    const input = sanitizeInput({ prompt: "p" });
    addPending("job-store-1", input, "1.1.1.1");
    expect(isKnown("job-store-1")).toBe(true);
    expect(submittedSince(0)).toBeGreaterThanOrEqual(1);
    const rec = { id: "job-store-1", status: "COMPLETED" as const, submittedAt: Date.now(), input };
    finish(rec);
    finish({ ...rec, status: "FAILED" }); // second finish is ignored
    expect(history().find((j) => j.id === "job-store-1")?.status).toBe("COMPLETED");
  });
});

describe("media library (in memory)", () => {
  it("validates ids before they can reach a file path", () => {
    expect(isValidId("0d2c5c3e-1111-2222-3333-444455556666-e1")).toBe(true);
    expect(isValidId("../../etc/passwd")).toBe(false);
    expect(isValidId("short")).toBe(false);
  });

  it("saves, reads, lists and deletes", () => {
    const base = { kind: "image" as const, prompt: "a", width: 8, height: 8, steps: 1 };
    expect(saveMedia({ ...base, id: "media-aaaa-1", createdAt: 1 }, JPEG)).toBe(true);
    expect(saveMedia({ ...base, id: "media-aaaa-2", createdAt: 2, kind: "video" }, JPEG)).toBe(true);
    expect(listMedia().map((m) => m.id).slice(0, 2)).toEqual(["media-aaaa-2", "media-aaaa-1"]);
    expect(readMedia("media-aaaa-2")?.mime).toBe("video/mp4");
    expect(readMedia("media-aaaa-1")?.bytes.toString()).toBe("fake-jpeg-bytes");
    expect(mediaUsage().persistent).toBe(false);
    expect(deleteImage("media-aaaa-1")).toBe(true);
    expect(deleteImage("media-aaaa-1")).toBe(false);
    expect(getMediaItem("media-aaaa-1")).toBeUndefined();
  });

  it("refuses invalid ids and keeps only the newest 50 in memory", () => {
    expect(saveMedia({ id: "bad/id", prompt: "", width: 1, height: 1, steps: 1, createdAt: 0 }, JPEG)).toBe(false);
    for (let i = 0; i < 60; i++) saveMedia({ id: `cap-test-${String(i).padStart(3, "0")}`, prompt: "", width: 1, height: 1, steps: 1, createdAt: 1000 + i }, JPEG);
    expect(listMedia().length).toBeLessThanOrEqual(50);
    expect(getMediaItem("cap-test-059")).toBeDefined();
    expect(getMediaItem("cap-test-000")).toBeUndefined();
  });
});

describe("prices", () => {
  it("prices a request as execution time x the GPU's per-second rate", () => {
    const gpu = "NVIDIA RTX 6000 Ada Generation";
    const hourly = pricePerHour(gpu)!;
    expect(hourly).toBeGreaterThan(0);
    expect(requestCost(gpu, 3_600_000)).toBeCloseTo(hourly, 6);
    expect(requestCost(gpu, 21_900)).toBeCloseTo((21.9 * hourly) / 3600, 8);
  });

  it("returns undefined for unknown GPUs or missing time", () => {
    expect(requestCost("Imaginary GPU", 1000)).toBeUndefined();
    expect(requestCost(undefined, 1000)).toBeUndefined();
    expect(requestCost("NVIDIA RTX 6000 Ada Generation", undefined)).toBeUndefined();
  });
});
