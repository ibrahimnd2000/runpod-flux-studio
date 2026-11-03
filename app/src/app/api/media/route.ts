import { connection } from "next/server";

import { config } from "@/lib/config";
import { listMedia, mediaUsage } from "@/lib/media";
import { syncPendingVideos } from "@/lib/videoJobs";
import type { MediaView } from "@/lib/types";

export async function GET() {
  await connection(); // live data: never prerender at build time
  await syncPendingVideos(); // clips finished while nobody was watching land here
  return Response.json({
    items: listMedia(),
    usage: mediaUsage(),
    videoEnabled: !!config.videoEndpointId,
  } satisfies MediaView);
}
