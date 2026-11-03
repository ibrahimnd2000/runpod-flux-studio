import "server-only";

import { saveImage } from "./media";
import { requestCost } from "./prices";
import { jobStatus } from "./runpod";
import { finish, getPending, getRecord } from "./store";
import { TERMINAL, type HandlerOutput, type JobView } from "./types";

/**
 * Checks Runpod for one image job this app submitted. On completion the image is
 * saved to the library and the job recorded in history (once). Shared by the
 * /api/jobs route and the agent tools. Returns null if the job is unknown;
 * throws if Runpod can't be reached.
 */
export async function refreshImageJob(id: string): Promise<JobView | null> {
  const done = getRecord(id);
  if (done) return done;
  const pending = getPending(id);
  if (!pending) return null;

  const s = await jobStatus(id);
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
  if (!TERMINAL.includes(s.status)) return view;

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
  return view;
}
