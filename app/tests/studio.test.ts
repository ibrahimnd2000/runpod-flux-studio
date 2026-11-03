import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EndpointView, HistoryView, JobView, MediaView, VideoJobView } from "@/lib/types";

// The Studio side (generate, bulk, job polling, library, video, endpoint, history)
// and the agents' real-GPU path, against a fake Runpod API that answers like the
// real one. Nothing leaves the process.

vi.stubEnv("RUNPOD_API_KEY", "rp-test");
vi.stubEnv("RUNPOD_IMAGE_ENDPOINT_ID", "img1");
vi.stubEnv("RUNPOD_WAN_ENDPOINT_ID", "wan1");
vi.mock("next/server", () => ({ connection: async () => {} }));

const JPEG = Buffer.from("jpeg-bytes-0123456789").toString("base64");
const MP4 = Buffer.from("mp4-bytes-0123456789").toString("base64");
const GPU = "NVIDIA RTX 6000 Ada Generation";

const fake = {
  n: 0,
  polls: new Map<string, number>(),
  /** Status polls a job needs before it completes. */
  pollsToFinish: 2,
  fail: false,
  submitted: [] as { url: string; body: Record<string, unknown> }[],
  auth: new Set<string>(),
};

function route(url: string, init?: RequestInit): Response {
  fake.auth.add(String((init?.headers as Record<string, string>)?.Authorization));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  let m: RegExpExecArray | null;
  if ((m = /api\.runpod\.ai\/v2\/(\w+)\/run$/.exec(url))) {
    if (fake.fail) return json({ error: "boom" }, 500);
    fake.submitted.push({ url, body: JSON.parse(String(init?.body)) });
    return json({ id: `${m[1]}-job-${String(++fake.n).padStart(4, "0")}-e1`, status: "IN_QUEUE" });
  }
  if ((m = /api\.runpod\.ai\/v2\/(\w+)\/status\/([\w-]+)$/.exec(url))) {
    const id = m[2];
    const k = (fake.polls.get(id) ?? 0) + 1;
    fake.polls.set(id, k);
    if (k < fake.pollsToFinish) return json({ id, status: "IN_PROGRESS", output: { step: 3, total_steps: 28 } });
    const worker = { id: "w1", gpu: GPU, vram_total_gb: 48, peak_vram_gb: 33.8, cold_start: false, model_load_ms: 0, process_ready_s: 1, jobs_served: 2 };
    const output =
      m[1] === "img1"
        ? { images: [JPEG], seed: 7, timings: { inference_ms: 21000, total_ms: 21900 }, worker, params: {} }
        : { video: MP4, bytes: 20, seed: 1, timings: { inference_ms: 80000, encode_ms: 900, total_ms: 81000 }, worker, params: { width: 736, height: 736, duration_s: 2.04, steps: 30 } };
    return json({ id, status: "COMPLETED", delayTime: 400, executionTime: 21900, output });
  }
  if (/\/health$/.test(url)) return json({ workers: { idle: 1, running: 0, initializing: 0 }, jobs: { inQueue: 0, inProgress: 0 } });
  if (/catalog\/gpus$/.test(url)) return json([{ id: GPU, pool: "ADA_48_PRO" }, { id: "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb", pool: "ADA_48_PRO" }, { id: "NVIDIA A40", pool: "AMPERE_48" }]);
  if ((m = /api\.runpod\.io\/v2\/serverless\/(\w+)$/.exec(url)))
    return json({ id: m[1], name: "flux", gpu: { pools: ["ADA_48_PRO", "AMPERE_48"], excludedTypes: ["NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb"] }, workers: { min: 0, max: 2, idleTimeout: 60 }, flashboot: "FLASHBOOT" });
  return json({ error: `unexpected ${url}` }, 404);
}
vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => route(String(url), init)));

const generate = await import("@/app/api/generate/route");
const bulk = await import("@/app/api/bulk/route");
const jobs = await import("@/app/api/jobs/[id]/route");
const history = await import("@/app/api/history/route");
const mediaList = await import("@/app/api/media/route");
const mediaById = await import("@/app/api/media/[id]/route");
const animate = await import("@/app/api/animate/route");
const videos = await import("@/app/api/videos/[id]/route");
const endpoint = await import("@/app/api/endpoint/route");
const { executeTool } = await import("@/lib/agents/tools");
const { createRun } = await import("@/lib/agents/runs");

const req = (body: unknown, code: string | null = "test-code", ip = "198.51.100.1") =>
  new Request("http://test/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...(code ? { "x-access-code": code } : {}), "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const getJob = async (id: string) => (await (await jobs.GET(new Request("http://test"), params(id))).json()) as JobView;

beforeEach(() => {
  fake.pollsToFinish = 2;
  fake.fail = false;
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/generate + GET /api/jobs/[id]", () => {
  it("submits a sanitized JPEG job, reports progress, then saves the image with its cost", async () => {
    const r = await generate.POST(req({ prompt: "  a red bicycle  ", width: 4000, num_inference_steps: 90 }));
    expect(r.status).toBe(200);
    const { id, input } = await r.json();
    expect(input).toMatchObject({ prompt: "a red bicycle", width: 1024, num_inference_steps: 28 });
    expect(fake.submitted.at(-1)!.body.input).toMatchObject({ image_format: "jpeg", prompt: "a red bicycle" });

    const first = await getJob(id);
    expect(first).toMatchObject({ status: "IN_PROGRESS", progress: { step: 3, total_steps: 28 } });

    const done = await getJob(id);
    expect(done.status).toBe("COMPLETED");
    expect(done.output?.image).toBe(`data:image/jpeg;base64,${JPEG}`);
    expect(done.costUsd).toBeGreaterThan(0);

    // Recorded once: later polls come from history (no image data), not Runpod.
    const polls = fake.polls.get(id);
    const again = await getJob(id);
    expect(fake.polls.get(id)).toBe(polls);
    expect(again.output).not.toHaveProperty("image");

    // And it's in the library, served with the right type.
    const file = await mediaById.GET(new Request("http://test"), params(id));
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(JPEG);
  });

  it("never sends the API key anywhere but the Authorization header", () => {
    expect([...fake.auth]).toEqual(["Bearer rp-test"]);
    for (const s of fake.submitted) expect(JSON.stringify(s.body)).not.toContain("rp-test");
  });

  it("rejects bad codes, empty prompts, unknown jobs and Runpod outages", async () => {
    expect((await generate.POST(req({ prompt: "x" }, "nope"))).status).toBe(401);
    expect((await generate.POST(req({ prompt: " " }))).status).toBe(400);
    expect((await jobs.GET(new Request("http://test"), params("not-a-job"))).status).toBe(404);
    fake.fail = true;
    const r = await generate.POST(req({ prompt: "x" }));
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("rp-test");
  });
});

describe("POST /api/bulk", () => {
  it("submits one job per prompt x variation with distinct consecutive seeds", async () => {
    const r = await bulk.POST(req({ prompts: ["a cat", "", "a dog"], variations: 2 }, "test-code", "198.51.100.2"));
    const { jobs: js } = await r.json();
    expect(js).toHaveLength(4);
    const seeds = js.map((j: { input: { seed: number } }) => j.input.seed);
    expect(new Set(seeds).size).toBe(4);
    expect(seeds[3] - seeds[0]).toBe(3);
  });

  it("enforces the bulk size and needs at least one prompt", async () => {
    expect((await bulk.POST(req({ prompts: ["a"], variations: 50 }, "test-code", "198.51.100.3"))).status).toBe(200); // clamped to 8
    expect((await bulk.POST(req({ prompts: ["a", "b", "c"], variations: 3 }, "test-code", "198.51.100.4"))).status).toBe(400);
    expect((await bulk.POST(req({ prompts: [] }))).status).toBe(400);
  });

  it("returns one clear error when nothing reached Runpod", async () => {
    fake.fail = true;
    const r = await bulk.POST(req({ prompts: ["a", "b"] }, "test-code", "198.51.100.5"));
    expect(r.status).toBe(502);
  });
});

describe("library routes", () => {
  it("serves byte ranges for video seeking", async () => {
    const { id } = await (await generate.POST(req({ prompt: "range test" }, "test-code", "198.51.100.6"))).json();
    fake.pollsToFinish = 1;
    await getJob(id);
    const size = Buffer.from(JPEG, "base64").length;
    const part = await mediaById.GET(new Request("http://test", { headers: { range: "bytes=2-5" } }), params(id));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 2-5/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(4);
    const suffix = await mediaById.GET(new Request("http://test", { headers: { range: "bytes=-3" } }), params(id));
    expect(suffix.headers.get("content-range")).toBe(`bytes ${size - 3}-${size - 1}/${size}`);
    expect((await mediaById.GET(new Request("http://test", { headers: { range: "bytes=999-" } }), params(id))).status).toBe(416);
    const dl = await mediaById.GET(new Request("http://test?download"), params(id));
    expect(dl.headers.get("content-disposition")).toMatch(/attachment; filename="flux-.*\.jpg"/);
  });

  it("deletes with the code only, and rejects bad ids", async () => {
    const { items } = (await (await mediaList.GET()).json()) as MediaView;
    const id = items[0].id;
    const del = (code: string | null, target = id) =>
      mediaById.DELETE(new Request("http://test", { method: "DELETE", headers: code ? { "x-access-code": code } : {} }), params(target));
    expect((await del(null)).status).toBe(401);
    expect((await del("test-code", "../etc")).status).toBe(400);
    expect((await del("test-code")).status).toBe(200);
    expect((await del("test-code")).status).toBe(404);
    expect((await mediaById.GET(new Request("http://test"), params(id))).status).toBe(404);
  });
});

describe("video", () => {
  it("animates a library image on the Wan endpoint and saves the clip", async () => {
    const { items } = (await (await mediaList.GET()).json()) as MediaView;
    const source = items.find((i) => (i.kind ?? "image") === "image")!;
    const r = await animate.POST(req({ sourceId: source.id, prompt: "slow push-in", num_frames: 49 }, "test-code", "198.51.100.7"));
    expect(r.status).toBe(200);
    const { id, input } = await r.json();
    expect(input).toMatchObject({ model: "wan22", num_frames: 49 });
    const sent = fake.submitted.at(-1)!;
    expect(sent.url).toContain("/wan1/run");
    expect(String(sent.body.input && (sent.body.input as { image: string }).image)).toMatch(/^data:image\/jpeg;base64,/);

    fake.pollsToFinish = 1;
    const v = (await (await videos.GET(new Request("http://test"), params(id))).json()) as VideoJobView;
    expect(v.status).toBe("COMPLETED");
    expect(v.output).toMatchObject({ mediaId: id, url: `/api/media/${id}` });
    const clip = await mediaById.GET(new Request("http://test"), params(id));
    expect(clip.headers.get("content-type")).toBe("video/mp4");
  });

  it("rejects unknown sources and unknown video jobs", async () => {
    expect((await animate.POST(req({ sourceId: "missing-image-1", prompt: "pan" }, "test-code", "198.51.100.8"))).status).toBe(404);
    expect((await videos.GET(new Request("http://test"), params("nope"))).status).toBe(404);
  });
});

describe("GET /api/endpoint and /api/history", () => {
  it("merges endpoint config, health and the GPU catalog, minus excluded types", async () => {
    const v = (await (await endpoint.GET(new Request("http://test/api/endpoint"))).json()) as EndpointView;
    expect(v).toMatchObject({ id: "img1", workersMax: 2, flashboot: "FLASHBOOT", gpuPools: ["ADA_48_PRO", "AMPERE_48"] });
    expect(v.gpuTypes).toEqual([GPU, "NVIDIA A40"]);
    expect(v.health?.workers.idle).toBe(1);
    const video = await endpoint.GET(new Request("http://test/api/endpoint?which=video&model=ltx2"));
    expect(video.status).toBe(404); // LTX endpoint not configured here
  });

  it("summarises completed jobs and the limits", async () => {
    const h = (await (await history.GET()).json()) as HistoryView;
    expect(h.stats.completed).toBeGreaterThanOrEqual(2);
    expect(h.stats.warmExecP50Ms).toBe(21900);
    expect(h.limits).toMatchObject({ videoEnabled: true, videoModels: ["wan22"], bulkMax: 8 });
  });
});

describe("agent tools on the real GPU path", () => {
  it("generate_images submits real jobs, waits for them and charges the measured cost", async () => {
    fake.pollsToFinish = 1;
    const run = createRun({ kind: "agent", title: "t", brief: "b", budget: { maxUsd: 1, maxImages: 4, maxVideos: 0, maxTurns: 4 }, mock: false });
    const before = fake.submitted.length;
    const o = await executeTool(
      { id: "c1", name: "generate_images", args: { prompts: ["a red bicycle", "a blue bicycle"] } },
      run,
      { code: "test-code", ip: "198.51.100.9", dryRun: false, aborted: () => false },
      false,
    );
    expect(o.reply.isError).toBeFalsy();
    expect(fake.submitted.length - before).toBe(2);
    const body = JSON.parse(o.reply.content);
    expect(body.images[0]).toMatchObject({ gpu: GPU, seconds: 21.9 });
    expect(run.view.spend.images).toBe(2);
    expect(run.view.spend.gpuUsd).toBeCloseTo(2 * ((21.9 * 1.75) / 3600), 3);
  });

  it("agent image jobs still count against the app's limits", async () => {
    const run = createRun({ kind: "agent", title: "t", brief: "b", budget: { maxUsd: 1, maxImages: 8, maxVideos: 0, maxTurns: 4 }, mock: false });
    const o = await executeTool(
      { id: "c1", name: "generate_images", args: { prompts: ["x one", "x two", "x three"] } },
      run,
      { code: "wrong", ip: "198.51.100.10", dryRun: false, aborted: () => false },
      false,
    );
    expect(JSON.parse(o.reply.content).error).toMatch(/access code/);
    expect(run.view.spend.images).toBe(0);
  });
});
