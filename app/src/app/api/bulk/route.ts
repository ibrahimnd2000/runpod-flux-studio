import { config } from "@/lib/config";
import { checkAccess, checkCode, clientIp, LimitError, readJson, sanitizeInput } from "@/lib/limits";
import { submitImage } from "@/lib/loras";
import { addPending } from "@/lib/store";
import type { GenerateInput } from "@/lib/types";

// Bulk generation: one Runpod /run job per image, all submitted at once, so the
// endpoint's autoscaler can spread them across workers (up to the endpoint's max
// workers; the rest wait in Runpod's queue). The browser polls each job id.
export async function POST(req: Request) {
  const ip = clientIp(req);
  const code = req.headers.get("x-access-code");
  let release = () => {};
  try {
    checkCode(code); // before doing any work for the request
    const body = await readJson<Record<string, unknown>>(req);
    const raw = Array.isArray(body.prompts) ? body.prompts : [];
    if (raw.length > config.bulkMax)
      throw new LimitError(`A bulk run is limited to ${config.bulkMax} images (you sent ${raw.length} prompts).`, 400);
    const prompts = raw.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean);
    const variations = Math.min(Math.max(Math.round(Number(body.variations) || 1), 1), config.bulkMax);
    if (!prompts.length) throw new LimitError("Add at least one prompt (one per line).", 400);

    const inputs: GenerateInput[] = prompts.flatMap((prompt) =>
      Array.from({ length: variations }, () => sanitizeInput({ ...body, prompt, seed: undefined })),
    );
    if (inputs.length > config.bulkMax)
      throw new LimitError(`A bulk run is limited to ${config.bulkMax} images (you asked for ${inputs.length}).`, 400);

    release = checkAccess(code, ip, inputs.length);

    // Distinct seeds so variations of one prompt differ, but stay reproducible.
    const base = Math.floor(Math.random() * 2 ** 31);
    inputs.forEach((input, i) => (input.seed = base + i));

    const results = await Promise.allSettled(inputs.map((input) => submitImage(input)));
    const jobs = results.map((r, i) => {
      if (r.status === "fulfilled") {
        addPending(r.value.id, inputs[i], ip);
        return { id: r.value.id, status: r.value.status, input: inputs[i] };
      }
      console.error("bulk submit failed", r.reason);
      return { id: null, status: "FAILED" as const, input: inputs[i], error: "Could not submit this job to Runpod." };
    });
    // Nothing reached Runpod (bad key, API down): one clear error, not N failed cards.
    if (jobs.every((j) => !j.id))
      return Response.json({ error: "Could not submit any job to Runpod. Try again shortly." }, { status: 502 });
    return Response.json({ submittedAt: Date.now(), jobs });
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    console.error("bulk failed", e);
    return Response.json({ error: "Could not submit the bulk run." }, { status: 502 });
  } finally {
    release();
  }
}
