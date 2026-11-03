import { connection } from "next/server";

import type { AgentsConfigView } from "@/lib/agentTypes";
import { PERSONAS } from "@/lib/agents/agent";
import { judgeOption } from "@/lib/agents/battle";
import { MEASURED, videoAvailable } from "@/lib/agents/gpu";
import { TEMPLATES } from "@/lib/agents/pipeline";
import { modelOptions } from "@/lib/agents/providers";
import { DEFAULT_BUDGET, gpuConfigured, MAX_BUDGET } from "@/lib/agents/request";
import { toolCatalog } from "@/lib/agents/tools";

// What the orchestration pages can offer on this deployment: which LLMs are
// configured, the tools, pipeline templates and budget limits.
export async function GET() {
  await connection();
  const models = modelOptions();
  const llm = models.find((m) => m.provider !== "scripted") ?? models[0];
  return Response.json({
    models,
    personas: PERSONAS.map(({ id, label, description }) => ({ id, label, description })),
    tools: toolCatalog(),
    templates: TEMPLATES.map((t) => ({ ...t, llm: { provider: llm.provider, model: llm.model } })),
    defaultBudget: DEFAULT_BUDGET,
    maxBudget: MAX_BUDGET,
    judge: judgeOption(),
    mock: !gpuConfigured(),
    videoEnabled: videoAvailable(),
    prices: { imageUsd: MEASURED.imageUsd, videoUsdPerS: MEASURED.videoUsdPerS, imageWarmS: MEASURED.imageWarmS },
  } satisfies AgentsConfigView);
}
