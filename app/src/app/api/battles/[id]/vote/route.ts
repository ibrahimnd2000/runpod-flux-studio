import { voteBattle } from "@/lib/agents/battle";
import { checkCode, LimitError } from "@/lib/limits";

// A person's verdict; it overrides the judge on the leaderboard.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkCode(req.headers.get("x-access-code"));
    const { vote } = (await req.json()) as { vote?: string };
    if (vote !== "a" && vote !== "b" && vote !== "tie") throw new LimitError("Vote a, b or tie.", 400);
    const { id } = await params;
    const b = voteBattle(id, vote);
    return b ? Response.json(b) : Response.json({ error: "That battle isn't finished." }, { status: 409 });
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
