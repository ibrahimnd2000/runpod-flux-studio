import { connection } from "next/server";

import { activeVideoCount } from "@/lib/videoStore";

// How many clips are in flight, for the nav badge. Memory only: never calls Runpod.
export async function GET() {
  await connection();
  return Response.json({ active: activeVideoCount() });
}
