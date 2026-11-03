import { saveImage } from "@/lib/media";
import { requestCost } from "@/lib/prices";
import { jobStatus } from "@/lib/runpod";
import { finish, getPending, getRecord, isKnown } from "@/lib/store";
import { TERMINAL, type HandlerOutput, type JobView } from "@/lib/types";

// Proxies Runpod /status for a job this app submitted, and records it in history
// once it reaches a terminal state.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Only jobs submitted through this app: the endpoint key can't be used to read others.
  if (!isKnown(id)) return Response.json({ error: "Unknown job." }, { status: 404 });

  const done = getRecord(id);
  if (done) return Response.json(done satisfies JobView);

  const pending = getPending(id)!;
  let s;
  try {
    s = await jobStatus(id);
  } catch (e) {
    console.error("status failed", e);
    return Response.json({ error: "Could not reach Runpod." }, { status: 502 });
  }

  const view: JobView = {
    id,
    status: s.status,
    submittedAt: pending.submittedAt,
    input: pending.input,
    delayMs: s.delayTime,
    executionMs: s.executionTime,
  };

  if (s.status === "IN_PROGRESS" && s.output && typeof s.output === "object" && "step" in s.output) {
    view.progress = s.output as JobView["progress"];
  }

  if (TERMINAL.includes(s.status)) {
    view.clientWallMs = Date.now() - pending.submittedAt;
    const out = (s.output ?? {}) as Partial<HandlerOutput>;
    view.error = s.error || out.error;
    if (s.status === "COMPLETED" && out.images?.length) {
      const { images, ...meta } = out as HandlerOutput;
      view.output = { ...meta, image: `data:image/jpeg;base64,${images[0]}` };
      view.costUsd = requestCost(meta.worker?.gpu, s.executionTime);
      saveImage(
        {
          id,
          createdAt: Date.now(),
          prompt: pending.input.prompt,
          width: pending.input.width,
          height: pending.input.height,
          steps: pending.input.num_inference_steps,
          seed: meta.seed,
          gpu: meta.worker?.gpu,
          executionMs: s.executionTime,
          costUsd: view.costUsd,
        },
        images[0],
      );
      finish({ ...view, output: meta });
    } else {
      finish(view);
    }
  }
  return Response.json(view);
}
