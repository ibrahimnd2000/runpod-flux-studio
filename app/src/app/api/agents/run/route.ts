import { runAgent } from "@/lib/agents/agent";
import { checkRunAccess, errorResponse, gpuContext, parseBrief, parseBudget, parseContestant } from "@/lib/agents/request";
import { createRun } from "@/lib/agents/runs";

// Starts an agent run in the background and returns its id; the browser polls
// /api/runs/[id] for the trace.
export async function POST(req: Request) {
  try {
    checkRunAccess(req);
    const body = (await req.json()) as Record<string, unknown>;
    const brief = parseBrief(body.brief);
    const { contestant, model } = parseContestant(body.contestant);
    const budget = parseBudget(body.budget);
    const dryRun = gpuContext(req, body.dryRun === true).dryRun;
    const run = createRun({ kind: "agent", title: model.label, brief, contestant, budget, mock: dryRun });
    void runAgent(run, model, contestant, gpuContext(req, dryRun, run));
    return Response.json({ id: run.view.id });
  } catch (e) {
    return errorResponse(e, "agent run");
  }
}
