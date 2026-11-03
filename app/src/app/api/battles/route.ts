import { connection } from "next/server";

import type { Side } from "@/lib/agentTypes";
import { leaderboard, startBattle } from "@/lib/agents/battle";
import { checkRunAccess, errorResponse, gpuContext, parseBrief, parseBudget, parseContestant } from "@/lib/agents/request";
import { listBattles } from "@/lib/agents/runs";

export async function GET() {
  await connection();
  return Response.json({ battles: listBattles().slice(0, 20), leaderboard: leaderboard() });
}

// Two agents, same brief, same budget, at the same time.
export async function POST(req: Request) {
  try {
    checkRunAccess(req, 2);
    const body = (await req.json()) as Record<string, unknown>;
    const brief = parseBrief(body.brief);
    const budget = parseBudget(body.budget);
    const a = parseContestant(body.a);
    const b = parseContestant(body.b);
    const dryRun = gpuContext(req, body.dryRun === true).dryRun;
    const battle = startBattle(
      brief,
      budget,
      { a: a.contestant, b: b.contestant } as Record<Side, typeof a.contestant>,
      { a: a.model, b: b.model },
      dryRun,
      (run) => gpuContext(req, dryRun, run),
      body.judge !== false,
    );
    return Response.json(battle);
  } catch (e) {
    return errorResponse(e, "battle");
  }
}
