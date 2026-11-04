import { describe, expect, it, vi } from "vitest";

import type { AgentsConfigView, BattleView, RunPollView } from "@/lib/agentTypes";

// The API routes, called as plain handlers. No GPU or LLM is configured in tests,
// so every run is a dry run with the scripted model.

vi.mock("next/server", () => ({ connection: async () => {} }));

const config = await import("@/app/api/agents/config/route");
const agentRun = await import("@/app/api/agents/run/route");
const pipelineRun = await import("@/app/api/pipelines/run/route");
const runs = await import("@/app/api/runs/route");
const runById = await import("@/app/api/runs/[id]/route");
const stop = await import("@/app/api/runs/[id]/stop/route");
const battles = await import("@/app/api/battles/route");
const battleById = await import("@/app/api/battles/[id]/route");
const vote = await import("@/app/api/battles/[id]/vote/route");
const mediaList = await import("@/app/api/media/route");
const judge = await import("@/app/api/battles/[id]/judge/route");

const post = (body: unknown, code: string | null = "test-code") =>
  new Request("http://test/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...(code ? { "x-access-code": code } : {}), "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const scripted = { provider: "scripted", model: "scripted", persona: "balanced" };

async function poll(id: string): Promise<RunPollView> {
  for (let i = 0; i < 200; i++) {
    const v = (await (await runById.GET(new Request(`http://test/api/runs/${id}`), params(id))).json()) as RunPollView;
    if (v.status !== "running") return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("run did not finish");
}

describe("GET /api/agents/config", () => {
  it("describes models, tools, templates and limits; dry-run only without a GPU endpoint", async () => {
    const c = (await (await config.GET()).json()) as AgentsConfigView;
    expect(c.models.map((m) => m.provider)).toEqual(["scripted"]);
    expect(c.mock).toBe(true);
    expect(c.judge).toBeNull();
    expect(c.templates.map((t) => t.id)).toEqual(["launch-kit", "style-explorer", "storyboard"]);
    expect(c.templates[0].llm).toEqual({ provider: "scripted", model: "scripted" });
    expect(c.tools.map((t) => t.name)).toContain("generate_images");
    expect(c.prices.imageUsd).toBeGreaterThan(0);
    expect(c.maxBudget.maxUsd).toBeGreaterThanOrEqual(c.defaultBudget.maxUsd);
  });
});

describe("POST /api/agents/run", () => {
  it("needs the access code", async () => {
    expect((await agentRun.POST(post({ brief: "a red bicycle", contestant: scripted }, null))).status).toBe(401);
    expect((await agentRun.POST(post({ brief: "a red bicycle", contestant: scripted }, "wrong"))).status).toBe(401);
  });

  it("answers a malformed body with a 400, on every POST route", async () => {
    const bad = (body: string) =>
      new Request("http://test/api", { method: "POST", headers: { "content-type": "application/json", "x-access-code": "test-code" }, body });
    for (const route of [agentRun.POST, pipelineRun.POST, battles.POST]) {
      for (const body of ["{oops", "[1]", "null"]) {
        const r = await route(bad(body));
        expect(r.status).toBe(400);
        expect((await r.json()).error).toMatch(/JSON object/);
      }
    }
    expect((await vote.POST(bad("{oops"), params("bat_x"))).status).toBe(400);
  });

  it("validates the brief and the model", async () => {
    expect((await agentRun.POST(post({ brief: "hi", contestant: scripted }))).status).toBe(400);
    const r = await agentRun.POST(post({ brief: "a red bicycle in Paris", contestant: { provider: "claude", model: "claude-opus-5-5" } }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/isn't available/);
  });

  it("starts a run that finishes in the background; clamps the budget", async () => {
    const r = await agentRun.POST(post({ brief: "a red bicycle in Paris", contestant: scripted, budget: { maxUsd: 999, maxImages: 999, maxTurns: 0 } }));
    expect(r.status).toBe(200);
    const { id } = await r.json();
    const v = await poll(id);
    expect(v).toMatchObject({ kind: "agent", status: "done", mock: true });
    expect(v.budget.maxUsd).toBeLessThanOrEqual(1);
    expect(v.budget.maxImages).toBeLessThanOrEqual(8);
    expect(v.budget.maxTurns).toBeGreaterThanOrEqual(1);
    // Every media id the run mentions is described for the browser.
    for (const m of v.result!.mediaIds) expect(v.media[m]?.kind).toBe("image");
  });

  it("keeps dry-run placeholders out of the library", async () => {
    const { id } = await (await agentRun.POST(post({ brief: "a teal vintage scooter", contestant: scripted }))).json();
    const v = await poll(id);
    const ids = v.result!.mediaIds;
    expect(ids.length).toBeGreaterThan(0);
    const library = (await (await mediaList.GET()).json()) as { items: { id: string }[] };
    expect(library.items.filter((i) => ids.includes(i.id))).toEqual([]);
  });
});

describe("GET /api/runs/[id]", () => {
  it("returns only events after ?after=, and 404s unknown runs", async () => {
    const { id } = await (await agentRun.POST(post({ brief: "a lighthouse in fog", contestant: scripted }))).json();
    const full = await poll(id);
    const tail = (await (await runById.GET(new Request(`http://test/api/runs/${id}?after=2`), params(id))).json()) as RunPollView;
    expect(tail.events.every((e) => e.seq > 2)).toBe(true);
    expect(tail.events.length).toBe(full.events.length - 3);
    expect((await runById.GET(new Request("http://test/api/runs/nope"), params("nope"))).status).toBe(404);
  });

  it("lists recent runs without events", async () => {
    const list = await (await runs.GET()).json();
    expect(list.runs.length).toBeGreaterThan(0);
    expect(list.runs[0]).not.toHaveProperty("events");
  });
});

describe("POST /api/runs/[id]/stop", () => {
  it("needs the code and a running run", async () => {
    expect((await stop.POST(post({}, null), params("x"))).status).toBe(401);
    expect((await stop.POST(post({}), params("run_missing"))).status).toBe(404);
  });
});

describe("POST /api/pipelines/run", () => {
  it("rejects a missing or invalid spec", async () => {
    expect((await pipelineRun.POST(post({}))).status).toBe(400);
    const bad = { id: "x", name: "x", description: "", inputs: [], llm: { provider: "scripted", model: "scripted" }, steps: [{ id: "a", type: "pick", title: "" }] };
    const r = await pipelineRun.POST(post({ spec: bad }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/from/);
  });

  it("runs a template with the given inputs", async () => {
    const c = (await (await config.GET()).json()) as AgentsConfigView;
    const spec = c.templates.find((t) => t.id === "style-explorer")!;
    const { id } = await (await pipelineRun.POST(post({ spec, inputs: { subject: "a fox in snow" } }))).json();
    const v = await poll(id);
    expect(v.status).toBe("done");
    expect(v.brief).toBe("a fox in snow");
    expect(v.spend.images).toBe(4); // 1 literal + 3 styles
    expect(v.pipeline?.steps).toHaveLength(3);
  });
});

describe("battles", () => {
  it("starts a battle, accepts a vote once finished, and ranks it", async () => {
    const r = await battles.POST(post({ brief: "a neon ramen shop at night", a: { ...scripted, persona: "frugal" }, b: scripted }));
    expect(r.status).toBe(200);
    const started = (await r.json()) as BattleView;
    await Promise.all([poll(started.runs.a), poll(started.runs.b)]);
    let b: BattleView = started;
    for (let i = 0; i < 100 && b.status !== "done"; i++) {
      b = await (await battleById.GET(new Request("http://test"), params(started.id))).json();
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(b.status).toBe("done");

    expect((await vote.POST(post({ vote: "maybe" }), params(b.id))).status).toBe(400);
    expect((await vote.POST(post({ vote: "a" }, null), params(b.id))).status).toBe(401);
    const voted = (await (await vote.POST(post({ vote: "a" }), params(b.id))).json()) as BattleView;
    expect(voted.vote).toBe("a");

    const board = await (await battles.GET()).json();
    expect(board.battles[0].id).toBe(b.id);
    expect(board.leaderboard[0]).toMatchObject({ wins: 1, contestant: { persona: "frugal" } });
  });

  it("re-judging needs the code and a configured judge", async () => {
    expect((await judge.POST(post({}, null), params("bat_x"))).status).toBe(401);
    const r = await judge.POST(post({}), params("bat_x"));
    expect(r.status).toBe(409); // no ANTHROPIC_API_KEY in tests
    expect((await r.json()).error).toMatch(/can't be judged/);
  });

  it("404s unknown battles", async () => {
    expect((await battleById.GET(new Request("http://test"), params("bat_nope"))).status).toBe(404);
  });
});
