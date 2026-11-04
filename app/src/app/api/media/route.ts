import { connection } from "next/server";

import { videoModels } from "@/lib/config";
import { listMedia, mediaUsage } from "@/lib/media";
import { syncPendingVideos } from "@/lib/videoJobs";
import { failedVideosSince, getVideoRecord } from "@/lib/videoStore";
import type { MediaView } from "@/lib/types";

// How long a failed clip keeps its tile in the Library.
const SHOW_FAILED_MS = 3 * 60 * 60_000;

export async function GET() {
  await connection(); // live data: never prerender at build time
  const active = await syncPendingVideos(); // clips finished while nobody was watching land here
  return Response.json({
    // Clips saved before the model was recorded: their job (same id) knows it.
    items: listMedia().map((i) => (i.kind === "video" && !i.model ? { ...i, model: getVideoRecord(i.id)?.input.model ?? "ltx2" } : i)),
    usage: mediaUsage(),
    videoEnabled: videoModels().length > 0,
    videoModels: videoModels(),
    videoJobs: [...active, ...failedVideosSince(Date.now() - SHOW_FAILED_MS)],
  } satisfies MediaView);
}
