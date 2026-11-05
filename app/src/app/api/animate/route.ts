import { config } from "@/lib/config";
import { checkCode, checkVideoAccess, clientIp, LimitError, readJson, sanitizeAnimate } from "@/lib/limits";
import { getMediaItem, readMedia } from "@/lib/media";
import { submitVideoJob } from "@/lib/runpod";
import { addVideoPending } from "@/lib/videoStore";

// Animate a library image with the selected video model (Wan 2.2 or LTX-2.5). The
// browser sends only the library id; the image bytes come from the app's own volume.
export async function POST(req: Request) {
  const ip = clientIp(req);
  const code = req.headers.get("x-access-code");
  let release = () => {};
  try {
    checkCode(code);
    const input = sanitizeAnimate(await readJson(req));
    const source = getMediaItem(input.sourceId);
    const file = readMedia(input.sourceId);
    if (!source || !file || file.kind !== "image") throw new LimitError("That image isn't in the library any more.", 404);
    release = checkVideoAccess(code, ip);

    const job = await submitVideoJob(config.videoEndpoints[input.model!], {
      image: `data:${file.mime};base64,${file.bytes.toString("base64")}`,
      prompt: input.prompt,
      resolution: input.resolution,
      num_frames: input.num_frames,
      audio: input.audio,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    });
    addVideoPending(job.id, input, source.prompt);
    return Response.json({ id: job.id, status: job.status, input });
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    console.error("animate failed", e);
    return Response.json({ error: "Could not submit the video job to Runpod." }, { status: 502 });
  } finally {
    release();
  }
}
