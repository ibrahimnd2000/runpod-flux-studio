import { checkCode, LimitError } from "@/lib/limits";
import { stopRun } from "@/lib/agents/runs";

// Stops after the current turn or step; GPU jobs already submitted still finish.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkCode(req.headers.get("x-access-code"));
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { id } = await params;
  return stopRun(id) ? Response.json({ ok: true }) : Response.json({ error: "That run isn't running." }, { status: 404 });
}
