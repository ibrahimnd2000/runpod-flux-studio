import { refreshVideoJob } from "@/lib/videoJobs";
import { isVideoKnown } from "@/lib/videoStore";

// Proxies Runpod /status for a video job this app submitted (see lib/videoJobs.ts).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isVideoKnown(id)) return Response.json({ error: "Unknown video job." }, { status: 404 });
  try {
    return Response.json(await refreshVideoJob(id));
  } catch (e) {
    console.error("video status failed", e);
    return Response.json({ error: "Could not reach Runpod." }, { status: 502 });
  }
}
