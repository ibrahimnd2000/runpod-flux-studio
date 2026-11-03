import { connection } from "next/server";

import { listRuns } from "@/lib/agents/runs";

export async function GET() {
  await connection();
  return Response.json({ runs: listRuns(30) });
}
