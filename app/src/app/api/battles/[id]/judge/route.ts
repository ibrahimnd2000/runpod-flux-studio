import { rejudgeBattle } from "@/lib/agents/battle";
import { checkCode, LimitError } from "@/lib/limits";

// Runs the Claude judge again on a finished battle (one judge call, ~$0.03).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkCode(req.headers.get("x-access-code"));
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const pending = rejudgeBattle(id);
  if (!pending) return Response.json({ error: "That battle can't be judged now (unknown, still running, or no judge configured)." }, { status: 409 });
  return Response.json(await pending);
}
