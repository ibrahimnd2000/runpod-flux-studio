import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import type { ModelOption, ProviderId } from "../agentTypes";
import { config } from "../config";

// The LLMs that drive pipelines, agents and the judge, behind one small session
// interface. Each adapter keeps its own provider-native history (append-only), so
// nothing is translated back and forth between formats:
//   claude   - Anthropic Messages API via the official SDK (ANTHROPIC_API_KEY).
//   runpod   - an open model on a Runpod Serverless vLLM endpoint, through the
//              worker's OpenAI-compatible route (RUNPOD_LLM_ENDPOINT_ID).
//   scripted - no LLM at all: a fixed plan, as a baseline and for keyless dev.

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>; // JSON Schema of the input object
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolReply {
  id: string;
  name: string;
  content: string; // JSON text
  images?: { mime: "image/jpeg" | "image/png"; data: string }[];
  isError?: boolean;
}

export interface UserContent {
  text: string;
  images?: { mime: "image/jpeg" | "image/png"; data: string }[];
}

export interface Turn {
  model: string;
  texts: string[];
  thinking: string[];
  calls: ToolCall[];
  stop: "tool_use" | "end" | "refusal" | "max_tokens";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimated: boolean;
  ms: number;
}

export interface LlmSession {
  turn(): Promise<Turn>;
  reply(results: ToolReply[]): void;
}

// --------------------------------------------------------------------------- //
//                                   Catalog                                   //
// --------------------------------------------------------------------------- //
// $ per million tokens (Anthropic list prices; Haiku's is for prompts up to 100K).
const CLAUDE = [
  { model: "claude-opus-5-5", label: "Claude Opus 5.5", inUsd: 4, outUsd: 20, fallbacks: true },
  { model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", inUsd: 2, outUsd: 10, fallbacks: true },
  { model: "claude-haiku-5-5", label: "Claude Haiku 5.5", inUsd: 0.1, outUsd: 0.5, fallbacks: false },
] as const;

const llmEndpoint = process.env.RUNPOD_LLM_ENDPOINT_ID ?? "";
const llmModel = process.env.RUNPOD_LLM_MODEL ?? "Qwen/Qwen3-8B";
// vLLM bills GPU-seconds, not tokens: cost is wall time x this price (an estimate,
// labelled as one). Default: the 24 GB serverless pool's list price.
const llmUsdPerHour = Number(process.env.RUNPOD_LLM_USD_PER_HOUR) || 0.76;

export const claudeEnabled = () => !!process.env.ANTHROPIC_API_KEY;
export const runpodLlmEnabled = () => !!(llmEndpoint && config.apiKey);

export function modelOptions(): ModelOption[] {
  const out: ModelOption[] = [];
  if (runpodLlmEnabled())
    out.push({ provider: "runpod", model: llmModel, label: `${llmModel.split("/").pop()} on Runpod vLLM`, vision: false, estimatedCost: true });
  if (claudeEnabled())
    for (const c of CLAUDE) out.push({ provider: "claude", model: c.model, label: c.label, vision: true, estimatedCost: false });
  out.push({ provider: "scripted", model: "scripted", label: "Scripted baseline (no LLM)", vision: false, estimatedCost: false });
  return out;
}

export function findModel(provider: ProviderId, model: string): ModelOption | undefined {
  return modelOptions().find((m) => m.provider === provider && m.model === model);
}

export function createSession(
  opt: ModelOption,
  system: string,
  user: UserContent,
  tools: ToolSpec[],
  maxTokens = 16000,
): LlmSession {
  if (opt.provider === "claude") return new ClaudeSession(opt.model, system, user, tools, maxTokens);
  if (opt.provider === "runpod") return new VllmSession(system, user, tools, Math.min(maxTokens, 4096));
  return new ScriptedSession(user.text, tools);
}

/** One call, no tools: for pipeline llm/pick steps. */
export async function complete(opt: ModelOption, system: string, user: UserContent, maxTokens = 8000): Promise<Turn> {
  return createSession(opt, system, user, [], maxTokens).turn();
}

// --------------------------------------------------------------------------- //
//                                    Claude                                   //
// --------------------------------------------------------------------------- //
let anthropic: Anthropic | null = null;
const client = () => (anthropic ??= new Anthropic());

class ClaudeSession implements LlmSession {
  private messages: Anthropic.Beta.BetaMessageParam[];
  private price: (typeof CLAUDE)[number];

  constructor(
    private model: string,
    private system: string,
    user: UserContent,
    private tools: ToolSpec[],
    private maxTokens: number,
  ) {
    this.price = CLAUDE.find((c) => c.model === model) ?? CLAUDE[0];
    this.messages = [{ role: "user", content: claudeContent(user.text, user.images) }];
  }

  async turn(): Promise<Turn> {
    const started = Date.now();
    const res = await client().beta.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: this.system,
      messages: this.messages,
      ...(this.tools.length
        ? { tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema })) }
        : {}),
      // Summaries of the model's reasoning appear in the run trace.
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
      // Tools + system prompt are identical on every turn of a run.
      cache_control: { type: "ephemeral" },
      // A safety decline is re-run on Anthropic's recommended fallback model.
      ...(this.price.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    // Append the full content (thinking blocks included) so history stays valid.
    this.messages.push({ role: "assistant", content: res.content });

    const u = res.usage;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const costUsd =
      ((u.input_tokens + cacheWrite * 1.25 + cacheRead * 0.1) * this.price.inUsd + u.output_tokens * this.price.outUsd) / 1e6;

    const turn: Turn = {
      model: res.model,
      texts: [],
      thinking: [],
      calls: [],
      stop: res.stop_reason === "tool_use" ? "tool_use" : res.stop_reason === "refusal" ? "refusal" : res.stop_reason === "max_tokens" ? "max_tokens" : "end",
      inputTokens: u.input_tokens + cacheWrite + cacheRead,
      outputTokens: u.output_tokens,
      costUsd,
      estimated: false,
      ms: Date.now() - started,
    };
    for (const b of res.content) {
      if (b.type === "text" && b.text.trim()) turn.texts.push(b.text);
      else if (b.type === "thinking" && b.thinking.trim()) turn.thinking.push(b.thinking);
      else if (b.type === "tool_use") turn.calls.push({ id: b.id, name: b.name, args: b.input });
    }
    return turn;
  }

  reply(results: ToolReply[]) {
    // All results of one turn go back in a single user message.
    this.messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        is_error: r.isError || undefined,
        content: r.images?.length ? claudeContent(r.content, r.images) : r.content,
      })),
    });
  }
}

function claudeContent(text: string, images?: UserContent["images"]) {
  return [
    ...(images ?? []).map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mime, data: img.data },
    })),
    { type: "text" as const, text },
  ];
}

// --------------------------------------------------------------------------- //
//                         Runpod Serverless vLLM (OpenAI route)               //
// --------------------------------------------------------------------------- //
interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

class VllmSession implements LlmSession {
  private messages: OaiMessage[];

  constructor(
    system: string,
    user: UserContent,
    private tools: ToolSpec[],
    private maxTokens: number,
  ) {
    this.messages = [
      { role: "system", content: system },
      { role: "user", content: user.text },
    ];
  }

  async turn(): Promise<Turn> {
    const started = Date.now();
    const body = {
      model: llmModel,
      messages: this.messages,
      max_tokens: this.maxTokens,
      ...(this.tools.length
        ? {
            tools: this.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
            tool_choice: "auto",
          }
        : {}),
      // Qwen3: skip the long <think> phase; tool calls are the agent's reasoning here.
      chat_template_kwargs: { enable_thinking: false },
    };
    // A cold worker loads the model first; the route holds the request meanwhile.
    const res = await fetch(`https://api.runpod.ai/v2/${llmEndpoint}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60_000),
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403)
      throw new Error(`Runpod vLLM ${res.status}: the app's Runpod API key has no access to endpoint ${llmEndpoint} (restricted keys must list it).`);
    if (!res.ok) throw new Error(`Runpod vLLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices: { message: OaiMessage; finish_reason: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const msg = data.choices[0]?.message ?? { role: "assistant", content: "" };
    this.messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });

    const ms = Date.now() - started;
    const raw = msg.content ?? "";
    const think = [...raw.matchAll(/<think>([\s\S]*?)<\/think>/g)].map((m) => m[1].trim()).filter(Boolean);
    const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const calls: ToolCall[] = (msg.tool_calls ?? []).map((c) => {
      let args: unknown;
      try {
        args = JSON.parse(c.function.arguments || "{}");
      } catch {
        args = { __unparsed: c.function.arguments };
      }
      return { id: c.id, name: c.function.name, args };
    });
    const finish = data.choices[0]?.finish_reason;
    return {
      model: llmModel,
      texts: text ? [text] : [],
      thinking: think,
      calls,
      stop: calls.length ? "tool_use" : finish === "length" ? "max_tokens" : "end",
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      costUsd: (ms / 3_600_000) * llmUsdPerHour,
      estimated: true,
      ms,
    };
  }

  reply(results: ToolReply[]) {
    // No vision on this model: image attachments are dropped (it never gets view_image).
    for (const r of results) this.messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
}

// --------------------------------------------------------------------------- //
//                              Scripted baseline                              //
// --------------------------------------------------------------------------- //
// A fixed plan: check the endpoints, generate two images (the brief as-is and a
// "styled" variant), finish with both. What an agent should beat.
class ScriptedSession implements LlmSession {
  private step = 0;
  private lastResults: ToolReply[] = [];

  constructor(
    private brief: string,
    private tools: ToolSpec[],
  ) {}

  async turn(): Promise<Turn> {
    const has = (n: string) => this.tools.some((t) => t.name === n);
    const base: Omit<Turn, "calls" | "texts" | "stop"> = {
      model: "scripted",
      thinking: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      estimated: false,
      ms: 0,
    };
    const subject = this.brief.replace(/^Brief:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 400);
    this.step += 1;
    if (!this.tools.length) {
      // Pipeline llm steps: echo the brief, numbered, as JSON when a list is asked for.
      const n = Number(/exactly (\d+)/.exec(subject)?.[1]) || 0;
      const gist = (/:\s*([^.:]{8,160})/.exec(subject)?.[1] ?? subject.slice(0, 160)).trim();
      const text = n
        ? JSON.stringify(Array.from({ length: n }, (_, i) => `${gist}, ${["studio photo", "golden hour", "overhead shot", "dramatic close-up"][i % 4]}`))
        : `[scripted baseline] ${gist}`;
      return { ...base, texts: [text], calls: [], stop: "end" };
    }
    if (this.step === 1 && has("check_endpoints"))
      return { ...base, texts: ["Plan: check the GPU endpoints, render two takes on the brief, deliver both."], calls: [{ id: "s1", name: "check_endpoints", args: {} }], stop: "tool_use" };
    if (this.step <= 2)
      return {
        ...base,
        texts: [],
        calls: [{ id: "s2", name: "generate_images", args: { prompts: [subject, `${subject}, cinematic lighting, highly detailed`], quality: "final" } }],
        stop: "tool_use",
      };
    if (this.step === 3) {
      const ids = this.lastResults.flatMap((r) => {
        try {
          return ((JSON.parse(r.content).images ?? []) as { media_id?: string }[]).map((i) => i.media_id).filter(Boolean) as string[];
        } catch {
          return [];
        }
      });
      return { ...base, texts: [], calls: [{ id: "s3", name: "finish", args: { summary: "Two takes on the brief, as written and styled.", media_ids: ids } }], stop: "tool_use" };
    }
    return { ...base, texts: ["Done."], calls: [], stop: "end" };
  }

  reply(results: ToolReply[]) {
    this.lastResults = results;
  }
}
