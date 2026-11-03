import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import type { Budget, Contestant, ModelOption, PersonaId } from "../agentTypes";
import type { GpuCtx } from "./gpu";
import { createSession, type ToolReply } from "./providers";
import { addSpend, emit, finishRun, totalUsd, type RunState } from "./runs";
import { executeTool, toolSpecs } from "./tools";

// The agent loop, shared by the playground and the battleground: the model plans,
// calls tools (in parallel when it asks for several at once), reads the results
// and repeats until it calls `finish`, stops calling tools, runs out of turns, or
// the run's budget is spent. All events go to the run's trace.

export const PERSONAS: { id: PersonaId; label: string; description: string; prompt: string }[] = [
  {
    id: "balanced",
    label: "Balanced",
    description: "Weighs quality against cost.",
    prompt: "Balance quality against cost: a small number of strong images beats many weak ones.",
  },
  {
    id: "frugal",
    label: "Frugal",
    description: "Fewest GPU jobs that satisfy the brief; reuses the library.",
    prompt:
      "Spend as little as possible. Check the library for something reusable first, use draft quality when it is enough, and never render more images than the brief needs.",
  },
  {
    id: "perfectionist",
    label: "Perfectionist",
    description: "Explores, inspects, refines; spends more of the budget.",
    prompt:
      "Quality first. Explore a few distinct directions, inspect the results, refine the strongest prompt and deliver only your best work, within the budget.",
  },
];

function systemPrompt(persona: PersonaId, vision: boolean, budget: Budget) {
  return [
    "You are a creative-production agent in FLUX Studio, a demo app running on Runpod Serverless.",
    "You fulfil a brief by calling tools that start real GPU jobs: FLUX.1-dev images and, when available, short image-to-video clips.",
    "Every GPU job costs money and time, and every tool result reports the budget left.",
    `This run's budget: $${budget.maxUsd.toFixed(2)} in total (GPU + your own tokens), at most ${budget.maxImages} images and ${budget.maxVideos} video clips, ${budget.maxTurns} turns. A call that would exceed it is refused.`,
    "Put several image prompts in one generate_images call: they run in parallel on separate GPU workers.",
    "Write FLUX prompts as concrete visual descriptions (subject, setting, lighting, composition, style), not as instructions.",
    vision
      ? "You can look at results with view_image; check images before you choose rather than assuming they came out well."
      : "You cannot see images; judge results by their prompts and the tool results.",
    PERSONAS.find((p) => p.id === persona)?.prompt ?? "",
    "When you are done, call finish once with the media ids that answer the brief (best first) and a short summary for the client. That ends the run.",
  ].join("\n");
}

function errorText(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key.";
  if (e instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit; try again in a minute.";
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ""}: ${e.message}`.slice(0, 300);
  return e instanceof Error ? e.message.slice(0, 300) : "Unknown error.";
}

/** Runs the agent to completion. Never throws; the outcome is in the run's status and trace. */
export async function runAgent(run: RunState, model: ModelOption, contestant: Contestant, gpu: GpuCtx) {
  const { budget } = run.view;
  const tools = toolSpecs({ vision: model.vision, dryRun: gpu.dryRun });
  const session = createSession(model, systemPrompt(contestant.persona, model.vision, budget), { text: `Brief:\n${run.view.brief}` }, tools);
  const produced: string[] = [];
  let lastText = "";

  emit(run, { type: "status", text: `${model.label} · ${contestant.persona} · ${tools.length} tools${gpu.dryRun ? " · dry run" : ""}` });
  try {
    for (let i = 0; i < budget.maxTurns; i++) {
      if (run.aborted) return finishRun(run, "stopped", { text: "Stopped by the user.", mediaIds: produced });

      const turn = await session.turn();
      addSpend(run, {
        llmUsd: turn.costUsd,
        llmEstimatedUsd: turn.estimated ? turn.costUsd : 0,
        turns: 1,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
      });
      if (model.provider !== "scripted")
        emit(run, { type: "llm", model: turn.model, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, ms: turn.ms, costUsd: turn.costUsd, estimated: turn.estimated });
      for (const t of turn.thinking) emit(run, { type: "thinking", text: t });
      for (const t of turn.texts) emit(run, { type: "text", text: t });
      if (turn.texts.length) lastText = turn.texts.join("\n\n");

      if (turn.stop === "refusal") return finishRun(run, "failed", { text: lastText, mediaIds: produced }, "The model declined this brief.");
      if (turn.stop === "max_tokens" && turn.calls.length)
        return finishRun(run, "failed", { text: lastText, mediaIds: produced }, "The model's reply was cut off mid tool call.");
      if (!turn.calls.length) return finishRun(run, "done", { text: lastText || "The agent stopped without a summary.", mediaIds: produced });

      for (const c of turn.calls) emit(run, { type: "tool_call", callId: c.id, name: c.name, args: c.args });
      const outcomes = await Promise.all(
        turn.calls.map(async (c) => {
          const started = Date.now();
          const o = await executeTool(c, run, gpu, model.vision);
          addSpend(run, { toolCalls: 1 });
          emit(run, { type: "tool_result", callId: c.id, name: c.name, ok: !o.reply.isError, summary: o.summary, mediaIds: o.mediaIds, ms: Date.now() - started, costUsd: o.costUsd });
          if (o.mediaIds && c.name !== "view_image" && c.name !== "search_library" && c.name !== "finish") produced.push(...o.mediaIds);
          return o;
        }),
      );

      const fin = outcomes.find((o) => o.finish)?.finish;
      if (fin) return finishRun(run, "done", { text: fin.summary, mediaIds: fin.mediaIds.length ? fin.mediaIds : produced });
      if (totalUsd(run.view.spend) >= budget.maxUsd)
        return finishRun(run, "done", { text: lastText || "Budget spent.", mediaIds: produced }, "Budget spent before the agent finished.");
      session.reply(outcomes.map((o): ToolReply => o.reply));
    }
    finishRun(run, "done", { text: lastText || "Turn limit reached.", mediaIds: produced }, `Turn limit (${budget.maxTurns}) reached before the agent finished.`);
  } catch (e) {
    console.error("agent run failed", e);
    emit(run, { type: "error", text: errorText(e) });
    finishRun(run, "failed", { text: lastText, mediaIds: produced }, errorText(e));
  }
}
