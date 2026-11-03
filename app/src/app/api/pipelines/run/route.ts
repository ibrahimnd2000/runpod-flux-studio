import type { PipelineSpec } from "@/lib/agentTypes";
import { runPipeline, validateSpec } from "@/lib/agents/pipeline";
import { findModel } from "@/lib/agents/providers";
import { checkRunAccess, errorResponse, gpuContext, parseBudget } from "@/lib/agents/request";
import { createRun } from "@/lib/agents/runs";
import { LimitError } from "@/lib/limits";

// Starts a pipeline run (a template or a user-edited spec) in the background.
export async function POST(req: Request) {
  try {
    checkRunAccess(req);
    const body = (await req.json()) as { spec?: PipelineSpec; inputs?: Record<string, unknown>; budget?: unknown; dryRun?: boolean };
    if (!body.spec) throw new LimitError("Missing pipeline.", 400);
    const spec = validateSpec(body.spec);
    const llm = findModel(spec.llm?.provider, String(spec.llm?.model ?? ""));
    if (!llm) throw new LimitError("That LLM isn't available on this deployment.", 400);
    const inputs = Object.fromEntries(
      (spec.inputs ?? []).map((i) => [i.key, String(body.inputs?.[i.key] ?? i.default ?? "").trim().slice(0, 500)]),
    );
    const budget = parseBudget(body.budget);
    const dryRun = gpuContext(req, body.dryRun === true).dryRun;
    const brief = Object.values(inputs).filter(Boolean).join(" · ");
    const run = createRun({ kind: "pipeline", title: spec.name, brief, pipeline: spec, budget, mock: dryRun });
    void runPipeline(run, spec, llm, inputs, gpuContext(req, dryRun, run));
    return Response.json({ id: run.view.id });
  } catch (e) {
    return errorResponse(e, "pipeline");
  }
}
