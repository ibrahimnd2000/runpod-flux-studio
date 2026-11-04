import { checkAccess, clientIp, LimitError, readJson, sanitizeInput } from "@/lib/limits";
import { submitImage } from "@/lib/loras";
import { addPending, noteIp } from "@/lib/store";

// Browser -> here -> Runpod /run. Returns the job id; the browser then polls
// /api/jobs/[id]. Async /run (not /runsync) so progress and queue time are visible.
export async function POST(req: Request) {
  const ip = clientIp(req);
  try {
    checkAccess(req.headers.get("x-access-code"), ip);
    const input = sanitizeInput(await readJson(req));
    const job = await submitImage(input);
    addPending(job.id, input, ip);
    noteIp(ip);
    return Response.json({ id: job.id, status: job.status, input });
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    console.error("generate failed", e);
    return Response.json({ error: "Could not submit the job to Runpod." }, { status: 502 });
  }
}
