import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoraView, LorasView } from "@/lib/types";

// LoRA fine-tuning: start a training job, accept the worker's upload only with
// its token, record the outcome, serve the file, and generate with it. Runpod is
// a fake that answers like the real API.

vi.stubEnv("RUNPOD_API_KEY", "rp-test");
vi.stubEnv("RUNPOD_IMAGE_ENDPOINT_ID", "img1");
vi.stubEnv("RUNPOD_TRAIN_ENDPOINT_ID", "train1");
vi.stubEnv("APP_PUBLIC_URL", "https://app.test/");
vi.stubEnv("LORA_DAILY_CAP", "2");
vi.mock("next/server", () => ({ connection: async () => {} }));

const fake = {
  submitted: [] as { url: string; input: Record<string, unknown> }[],
  status: { status: "IN_PROGRESS", output: { step: 40, total_steps: 400, loss: 0.31 } } as Record<string, unknown>,
};
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    let m: RegExpExecArray | null;
    if ((m = /\/v2\/(\w+)\/run$/.exec(url))) {
      fake.submitted.push({ url, input: JSON.parse(String(init?.body)).input });
      return Response.json({ id: `${m[1]}-job-${fake.submitted.length}`, status: "IN_QUEUE" });
    }
    if (/\/v2\/train1\/status\//.test(url)) return Response.json({ id: "x", delayTime: 4000, executionTime: 600_000, ...fake.status });
    return Response.json({ error: `unexpected ${url}` }, { status: 404 });
  }),
);

const { saveMedia } = await import("@/lib/media");
const loras = await import("@/app/api/loras/route");
const loraById = await import("@/app/api/loras/[id]/route");
const loraFile = await import("@/app/api/loras/[id]/file/route");
const generate = await import("@/app/api/generate/route");
const { sanitizeInput } = await import("@/lib/limits");

const JPEG = Buffer.from("jpeg-bytes").toString("base64");
const imageIds = Array.from({ length: 5 }, (_, i) => `img-0000000${i}-e1`);
imageIds.forEach((id, i) => saveMedia({ id, kind: "image", createdAt: Date.now() + i, prompt: `a ceramic mug, angle ${i}`, width: 1024, height: 1024, steps: 28 }, JPEG));
saveMedia({ id: "clip-00000001-e1", kind: "video", createdAt: Date.now(), prompt: "a clip", width: 736, height: 736, steps: 8 }, JPEG);
saveMedia({ id: "dry-placeholder-1", kind: "image", createdAt: Date.now(), prompt: "placeholder", width: 256, height: 256, steps: 0 }, JPEG);

const post = (body: unknown, code: string | null = "test-code") =>
  new Request("http://test/api/loras", {
    method: "POST",
    headers: { "content-type": "application/json", ...(code ? { "x-access-code": code } : {}), "x-forwarded-for": "198.51.100.30" },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (id: string, token: string | null, body: Uint8Array<ArrayBuffer>) =>
  loraFile.PUT(new Request(`http://test/api/loras/${id}/file`, { method: "PUT", headers: token ? { "x-upload-token": token } : {}, body }), params(id));
const list = async () => (await (await loras.GET()).json()) as LorasView;
const good = { name: "Mug shots", trigger: "zxq_mug", imageIds, steps: 400 };

beforeEach(() => {
  fake.status = { status: "IN_PROGRESS", output: { step: 40, total_steps: 400, loss: 0.31 } };
});

describe("starting a training", () => {
  it("validates the request", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...good, name: " " }, /name/],
      [{ ...good, trigger: "Has Space" }, /trigger word/],
      [{ ...good, imageIds: imageIds.slice(0, 3) }, /Pick 4-40 images/],
      [{ ...good, imageIds: [...imageIds.slice(0, 4), "clip-00000001-e1"] }, /isn't an image/],
      [{ ...good, imageIds: [...imageIds.slice(0, 4), "dry-placeholder-1"] }, /isn't an image/],
    ];
    for (const [body, msg] of cases) {
      const r = await loras.POST(post(body));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(msg);
    }
    expect((await loras.POST(post(good, null))).status).toBe(401);
    expect(fake.submitted).toEqual([]);
  });

  it("submits the library images with trigger-word captions and an upload URL", async () => {
    const r = await loras.POST(post({ ...good, steps: 99999 }));
    expect(r.status).toBe(200);
    const lora = (await r.json()) as LoraView;
    expect(lora).toMatchObject({ status: "training", trigger: "zxq_mug", steps: 2000, rank: 16, resolution: 512 });
    expect(lora).not.toHaveProperty("tokenHash");

    const job = fake.submitted.at(-1)!;
    expect(job.url).toBe("https://api.runpod.ai/v2/train1/run");
    expect(job.input).toMatchObject({ task: "train_lora", steps: 2000, rank: 16, resolution: 512, upload_url: `https://app.test/api/loras/${lora.id}/file` });
    expect((job.input.images as { url: string; caption: string }[])[0]).toEqual({ url: `https://app.test/api/media/${imageIds[0]}`, caption: "zxq_mug, a ceramic mug, angle 0" });
    expect(String(job.input.upload_token)).toMatch(/^[a-f0-9]{48}$/);

    // One at a time.
    const again = await loras.POST(post(good));
    expect(again.status).toBe(429);
    expect((await again.json()).error).toMatch(/already training/);
  });
});

describe("the training lifecycle", () => {
  it("reports progress, takes the upload only with the token, then becomes ready", async () => {
    const lora = (await list()).loras.find((l) => l.status === "training")!;
    const token = String(fake.submitted.at(-1)!.input.upload_token);

    // Queued: no GPU yet, and the record says so (not "training").
    fake.status = { status: "IN_QUEUE" };
    expect((await list()).loras.find((l) => l.id === lora.id)).toMatchObject({ status: "training", jobStatus: "IN_QUEUE" });
    fake.status = { status: "IN_PROGRESS", output: { step: 40, total_steps: 400, loss: 0.31 } };
    expect((await list()).loras.find((l) => l.id === lora.id)).toMatchObject({ jobStatus: "IN_PROGRESS", progress: { step: 40, total_steps: 400, loss: 0.31 } });
    expect((await put(lora.id, null, new Uint8Array([1]))).status).toBe(403);
    expect((await put(lora.id, "f".repeat(48), new Uint8Array([1]))).status).toBe(403);
    expect((await put(lora.id, token, new Uint8Array(0))).status).toBe(413);
    // Not downloadable while training.
    expect((await loraFile.GET(new Request("http://test"), params(lora.id))).status).toBe(404);

    const weights = new TextEncoder().encode("SAFETENSORS-BYTES");
    expect((await put(lora.id, token, weights)).status).toBe(200);
    fake.status = { status: "COMPLETED", output: { lora: { bytes: weights.length }, final_loss: 0.21, timings: { train_ms: 590_000 }, worker: { gpu: "NVIDIA L40S" } } };
    const done = (await (await loraById.GET(new Request("http://test"), params(lora.id))).json()) as LoraView;
    expect(done).toMatchObject({ status: "ready", finalLoss: 0.21, gpu: "NVIDIA L40S", executionMs: 600_000, bytes: weights.length });
    expect(done.costUsd).toBeGreaterThan(0);
    expect(done.progress).toBeUndefined();
    expect(done.jobStatus).toBeUndefined();

    // The token is spent: no second upload.
    expect((await put(lora.id, token, weights)).status).toBe(403);
    const file = await loraFile.GET(new Request("http://test"), params(lora.id));
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(weights);
  });

  it("generates with a ready LoRA: the worker gets its URL and scale", async () => {
    const lora = (await list()).loras.find((l) => l.status === "ready")!;
    const r = await generate.POST(post({ prompt: "zxq_mug on a beach", lora: { id: lora.id, scale: 0.85 } }));
    expect(r.status).toBe(200);
    const job = fake.submitted.at(-1)!;
    expect(job.url).toBe("https://api.runpod.ai/v2/img1/run");
    expect(job.input.lora).toEqual({ id: lora.id, url: `https://app.test/api/loras/${lora.id}/file`, scale: 0.85 });
    expect((await r.json()).input.lora).toEqual({ id: lora.id, scale: 0.85 });
  });

  it("rejects unknown or malformed LoRAs, and clamps the scale", async () => {
    const unknown = await generate.POST(post({ prompt: "a mug", lora: { id: "lora_000000000000" } }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toMatch(/isn't ready/);
    expect((await generate.POST(post({ prompt: "a mug", lora: { id: "../../etc" } }))).status).toBe(400);
    expect(sanitizeInput({ prompt: "x", lora: { id: "lora_abcdefabcdef", scale: 9 } }).lora).toEqual({ id: "lora_abcdefabcdef", scale: 2 });
    expect(sanitizeInput({ prompt: "x", lora: null }).lora).toBeUndefined();
  });

  it("records a failed training with the worker's error, and enforces the daily cap", async () => {
    const lora = (await (await loras.POST(post({ ...good, name: "Second" }))).json()) as LoraView;
    fake.status = { status: "COMPLETED", output: { error: "GPU out of memory while training" } };
    const failed = (await (await loraById.GET(new Request("http://test"), params(lora.id))).json()) as LoraView;
    expect(failed).toMatchObject({ status: "failed", error: "GPU out of memory while training" });

    const capped = await loras.POST(post({ ...good, name: "Third" }));
    expect(capped.status).toBe(429);
    expect((await capped.json()).error).toMatch(/Daily cap of 2/);
  });

  it("deletes with the code", async () => {
    const lora = (await list()).loras.find((l) => l.status === "failed")!;
    const del = (code: string | null) => loraById.DELETE(new Request("http://test", { method: "DELETE", headers: code ? { "x-access-code": code } : {} }), params(lora.id));
    expect((await del(null)).status).toBe(401);
    expect((await del("test-code")).status).toBe(200);
    expect((await list()).loras.some((l) => l.id === lora.id)).toBe(false);
    expect((await loraById.GET(new Request("http://test"), params(lora.id))).status).toBe(404);
  });
});
