import { connection } from "next/server";

import { listMedia, mediaUsage } from "@/lib/media";
import type { MediaView } from "@/lib/types";

export async function GET() {
  await connection(); // live data: never prerender at build time
  return Response.json({ items: listMedia(), usage: mediaUsage() } satisfies MediaView);
}
