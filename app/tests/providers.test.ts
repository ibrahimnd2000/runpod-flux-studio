import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Provider adapters: the exact request each one sends, how replies are parsed,
// and how cost is computed. No network: the Anthropic SDK and fetch are mocked.

const anthropicCalls: Record<string, unknown>[] = [];
let nextResponse: Record<string, unknown> = {};

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status?: number;
  }
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = class extends APIError {};
    static RateLimitError = class extends APIError {};
    beta = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          // Snapshot: the adapter keeps appending to the same messages array.
          anthropicCalls.push(structuredClone(params));
          return nextResponse;
        },
      },
    };
  }
  return { default: Anthropic };
});

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("@/lib/agents/providers");
}

const TOOL = { name: "generate_images", description: "Render", schema: { type: "object", properties: { prompts: { type: "array" } } } };

beforeEach(() => {
  anthropicCalls.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("modelOptions", () => {
  it("lists only what is configured; the scripted baseline is always there", async () => {
    let p = await load({ ANTHROPIC_API_KEY: "", RUNPOD_LLM_ENDPOINT_ID: "", RUNPOD_API_KEY: "" });
    expect(p.modelOptions().map((m) => m.provider)).toEqual(["scripted"]);

    p = await load({ ANTHROPIC_API_KEY: "sk-test", RUNPOD_LLM_ENDPOINT_ID: "ep123", RUNPOD_API_KEY: "rp-test" });
    const ms = p.modelOptions();
    expect(ms.map((m) => m.model)).toEqual(["Qwen/Qwen3-8B", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "scripted"]);
    expect(ms.find((m) => m.provider === "runpod")).toMatchObject({ vision: false, estimatedCost: true });
    expect(ms.filter((m) => m.provider === "claude").every((m) => m.vision)).toBe(true);
    expect(p.findModel("claude", "claude-opus-5-5")).toBeDefined();
    expect(p.findModel("claude", "gpt-whatever")).toBeUndefined();
  });
});

describe("Claude session", () => {
  const response = (content: unknown[], stop = "tool_use", usage = {}) => ({
    model: "claude-opus-5-5",
    stop_reason: stop,
    content,
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
  });

  it("sends adaptive thinking, effort, caching and fallbacks; no sampling params", async () => {
    const p = await load({ ANTHROPIC_API_KEY: "sk-test" });
    nextResponse = response([
      { type: "thinking", thinking: "I should render.", signature: "s" },
      { type: "text", text: "Rendering." },
      { type: "tool_use", id: "tu_1", name: "generate_images", input: { prompts: ["a"] } },
    ]);
    const s = p.createSession(p.findModel("claude", "claude-opus-5-5")!, "SYS", { text: "Brief" }, [TOOL]);
    const t = await s.turn();

    const req = anthropicCalls[0];
    expect(req).toMatchObject({
      model: "claude-opus-5-5",
      system: "SYS",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("tool_choice");
    expect((req.tools as { name: string; input_schema: unknown }[])[0]).toEqual({ name: "generate_images", description: "Render", input_schema: TOOL.schema });

    expect(t).toMatchObject({ stop: "tool_use", texts: ["Rendering."], thinking: ["I should render."], calls: [{ id: "tu_1", name: "generate_images", args: { prompts: ["a"] } }] });
    // $4 in / $20 out per MTok.
    expect(t.costUsd).toBeCloseTo((1000 * 4 + 200 * 20) / 1e6, 10);
    expect(t.estimated).toBe(false);
  });

  it("returns tool results in one user message and keeps the assistant turn intact", async () => {
    const p = await load({ ANTHROPIC_API_KEY: "sk-test" });
    const content = [{ type: "tool_use", id: "tu_1", name: "view_image", input: {} }, { type: "tool_use", id: "tu_2", name: "estimate_cost", input: {} }];
    nextResponse = response(content);
    const s = p.createSession(p.findModel("claude", "claude-opus-5-5")!, "SYS", { text: "Brief" }, [TOOL]);
    await s.turn();
    s.reply([
      { id: "tu_1", name: "view_image", content: "{}", images: [{ mime: "image/jpeg", data: "QUJD" }] },
      { id: "tu_2", name: "estimate_cost", content: '{"error":"x"}', isError: true },
    ]);
    nextResponse = response([{ type: "text", text: "Done." }], "end_turn");
    const t = await s.turn();
    expect(t.stop).toBe("end");

    const msgs = anthropicCalls[1].messages as { role: string; content: unknown }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content).toEqual(content);
    const results = msgs[2].content as Record<string, unknown>[];
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect((results[0].content as { type: string }[]).map((c) => c.type)).toEqual(["image", "text"]);
    expect(results[1]).toMatchObject({ tool_use_id: "tu_2", is_error: true, content: '{"error":"x"}' });
  });

  it("prices cache reads and writes, and maps refusals", async () => {
    const p = await load({ ANTHROPIC_API_KEY: "sk-test" });
    nextResponse = response([], "refusal", { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 });
    const t = await p.complete(p.findModel("claude", "claude-sonnet-5-5")!, "SYS", { text: "x" });
    expect(t.stop).toBe("refusal");
    expect(t.inputTokens).toBe(11100);
    expect(t.costUsd).toBeCloseTo(((100 + 1000 * 1.25 + 10000 * 0.1) * 2) / 1e6, 10);
    expect(anthropicCalls[0]).not.toHaveProperty("tools");
  });

  it("does not send fallbacks for Haiku (no server-side fallback there)", async () => {
    const p = await load({ ANTHROPIC_API_KEY: "sk-test" });
    nextResponse = response([{ type: "text", text: "ok" }], "end_turn");
    await p.complete(p.findModel("claude", "claude-haiku-5-5")!, "SYS", { text: "x" });
    expect(anthropicCalls[0]).not.toHaveProperty("fallbacks");
    expect(anthropicCalls[0]).not.toHaveProperty("betas");
  });
});

describe("Runpod vLLM session", () => {
  const env = { RUNPOD_LLM_ENDPOINT_ID: "ep123", RUNPOD_API_KEY: "rp-test", RUNPOD_LLM_USD_PER_HOUR: "3.6" };

  function mockFetch(...replies: { status?: number; body: unknown }[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const r = replies[Math.min(calls.length - 1, replies.length - 1)];
        return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
      }),
    );
    return calls;
  }

  it("calls the endpoint's OpenAI route with tools and parses tool calls", async () => {
    const p = await load(env);
    const calls = mockFetch({
      body: {
        choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "<think>hmm</think>", tool_calls: [
          { id: "c1", type: "function", function: { name: "generate_images", arguments: '{"prompts":["a"]}' } },
          { id: "c2", type: "function", function: { name: "finish", arguments: "{not json" } },
        ] } }],
        usage: { prompt_tokens: 171, completion_tokens: 38 },
      },
    });
    const s = p.createSession(p.findModel("runpod", "Qwen/Qwen3-8B")!, "SYS", { text: "Brief" }, [TOOL]);
    const t = await s.turn();

    expect(calls[0].url).toBe("https://api.runpod.ai/v2/ep123/openai/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer rp-test");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({ model: "Qwen/Qwen3-8B", tool_choice: "auto", chat_template_kwargs: { enable_thinking: false } });
    expect(body.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "Brief" }]);
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "generate_images", description: "Render", parameters: TOOL.schema } });

    expect(t.stop).toBe("tool_use");
    expect(t.thinking).toEqual(["hmm"]);
    expect(t.texts).toEqual([]);
    expect(t.calls).toEqual([
      { id: "c1", name: "generate_images", args: { prompts: ["a"] } },
      { id: "c2", name: "finish", args: { __unparsed: "{not json" } },
    ]);
    expect(t).toMatchObject({ inputTokens: 171, outputTokens: 38, estimated: true });
  });

  it("sends tool results as role=tool messages and drops image attachments", async () => {
    const p = await load(env);
    const calls = mockFetch(
      { body: { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] } }] } },
      { body: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "All done." } }] } },
    );
    const s = p.createSession(p.findModel("runpod", "Qwen/Qwen3-8B")!, "SYS", { text: "Brief" }, [TOOL]);
    await s.turn();
    s.reply([{ id: "c1", name: "x", content: '{"ok":true}', images: [{ mime: "image/jpeg", data: "QUJD" }] }]);
    const t = await s.turn();
    expect(t).toMatchObject({ stop: "end", texts: ["All done."] });
    const msgs = JSON.parse(calls[1].init.body as string).messages;
    expect(msgs.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: '{"ok":true}' });
    expect(msgs.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1" }] });
  });

  it("explains a 403 (restricted API key) and surfaces other errors", async () => {
    let p = await load(env);
    mockFetch({ status: 403, body: { title: "Forbidden" } });
    await expect(p.createSession(p.findModel("runpod", "Qwen/Qwen3-8B")!, "S", { text: "b" }, []).turn()).rejects.toThrow(/no access to endpoint ep123/);

    p = await load(env);
    mockFetch({ status: 500, body: "boom" });
    await expect(p.createSession(p.findModel("runpod", "Qwen/Qwen3-8B")!, "S", { text: "b" }, []).turn()).rejects.toThrow(/500: boom/);
  });
});

describe("scripted session", () => {
  it("returns a JSON list when a pipeline step asks for one", async () => {
    const p = await load({});
    const t = await p.complete(p.findModel("scripted", "scripted")!, "S", { text: "Ideas for: a mug. Return only a JSON array of exactly 3 strings." });
    expect(JSON.parse(t.texts[0])).toHaveLength(3);
    expect(t.costUsd).toBe(0);
  });
});
