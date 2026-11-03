import { connection } from "next/server";

import { getBattle } from "@/lib/agents/runs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const b = getBattle(id);
  return b ? Response.json(b) : Response.json({ error: "Unknown battle." }, { status: 404 });
}
