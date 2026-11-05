import { checkAccess, checkCode, clientIp, LimitError, readJson, sanitizeInput } from "@/lib/limits";
import { submitImage } from "@/lib/loras";
import { addPending } from "@/lib/store";

// Browser -> here -> Runpod /run. Returns the job id; the browser then polls
// /api/jobs/[id]. Async /run (not /runsync) so progress and queue time are visible.
export async function POST(req: Request) {
  const ip = clientIp(req);
  const code = req.headers.get("x-access-code");
  let release = () => {};
  try {
    checkCode(code);
    const input = sanitizeInput(await readJson(req));
    release = checkAccess(code, ip); // reserves the slot: no await between check and reservation
    const job = await submitImage(input);
    addPending(job.id, input, ip);
    return Response.json({ id: job.id, status: job.status, input });
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    console.error("generate failed", e);
    return Response.json({ error: "Could not submit the job to Runpod." }, { status: 502 });
  } finally {
    release();
  }
}
