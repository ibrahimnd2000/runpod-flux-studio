import { refreshImageJob } from "@/lib/imageJobs";
import { isKnown } from "@/lib/store";
import type { JobView } from "@/lib/types";

// Proxies Runpod /status for a job this app submitted, and records it in history
// once it reaches a terminal state.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Only jobs submitted through this app: the endpoint key can't be used to read others.
  if (!isKnown(id)) return Response.json({ error: "Unknown job." }, { status: 404 });
  try {
    return Response.json((await refreshImageJob(id)) satisfies JobView | null);
  } catch (e) {
    console.error("status failed", e);
    return Response.json({ error: "Could not reach Runpod." }, { status: 502 });
  }
}
