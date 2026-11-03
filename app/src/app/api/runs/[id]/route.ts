import { connection } from "next/server";

import type { RunPollView } from "@/lib/agentTypes";
import { getRun } from "@/lib/agents/runs";
import { getMediaItem } from "@/lib/media";

// A run with its events from `?after=<seq>` on, so polling stays cheap on long
// traces, plus the kind and prompt of every media id it mentions.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const run = getRun(id);
  if (!run) return Response.json({ error: "Unknown run." }, { status: 404 });
  const after = Number(new URL(req.url).searchParams.get("after") ?? -1);
  const ids = new Set([...(run.result?.mediaIds ?? []), ...run.events.flatMap((e) => ("mediaIds" in e ? (e.mediaIds ?? []) : []))]);
  const media: RunPollView["media"] = {};
  for (const m of ids) {
    const item = getMediaItem(m);
    if (item) media[m] = { kind: item.kind ?? "image", prompt: item.prompt };
  }
  return Response.json({ ...run, events: run.events.filter((e) => e.seq > after), media } satisfies RunPollView);
}
