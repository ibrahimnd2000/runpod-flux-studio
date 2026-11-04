import { connection } from "next/server";

import { config } from "@/lib/config";
import { checkCode, LimitError, readJson } from "@/lib/limits";
import { LORA_LIMITS, parseTrainRequest, startTraining, STEP_PRESETS, syncLoras, trainingEnabled } from "@/lib/loras";
import type { LorasView } from "@/lib/types";

export async function GET() {
  await connection(); // live data: never prerender at build time
  return Response.json({
    loras: await syncLoras(),
    enabled: trainingEnabled(),
    limits: { minImages: LORA_LIMITS.minImages, maxImages: LORA_LIMITS.maxImages, minSteps: LORA_LIMITS.minSteps, maxSteps: LORA_LIMITS.maxSteps, dailyCap: config.loraDailyCap },
    presets: STEP_PRESETS,
  } satisfies LorasView);
}

// Starts a training job on the training endpoint; the browser polls GET for progress.
export async function POST(req: Request) {
  try {
    checkCode(req.headers.get("x-access-code"));
    const lora = await startTraining(parseTrainRequest(await readJson<Record<string, unknown>>(req)));
    return Response.json(lora);
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    console.error("starting LoRA training failed", e);
    return Response.json({ error: "Could not start the training job on Runpod." }, { status: 502 });
  }
}
