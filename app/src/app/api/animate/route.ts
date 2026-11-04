import { config } from "@/lib/config";
import { checkVideoAccess, clientIp, LimitError, readJson, sanitizeAnimate } from "@/lib/limits";
import { getMediaItem, readMedia } from "@/lib/media";
import { submitVideoJob } from "@/lib/runpod";
import { noteIp } from "@/lib/store";
import { addVideoPending } from "@/lib/videoStore";

// Animate a library image with the LTX-2.5 endpoint. The browser sends only the
// library id; the image bytes come from the app's own volume (no large upload).
export async function POST(req: Request) {
  const ip = clientIp(req);
  try {
    checkVideoAccess(req.headers.get("x-access-code"), ip);
    const input = sanitizeAnimate(await readJson(req));
    const source = getMediaItem(input.sourceId);
    const file = readMedia(input.sourceId);
    if (!source || !file || file.kind !== "image") throw new LimitError("That image isn't in the library any more.", 404);

    const job = await submitVideoJob(config.videoEndpoints[input.model!], {
      image: `data:${file.mime};base64,${file.bytes.toString("base64")}`,
      prompt: input.prompt,
      resolution: input.resolution,
      num_frames: input.num_frames,
      audio: input.audio,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    });
    addVideoPending(job.id, input, source.prompt);
    noteIp(ip);
    return Response.json({ id: job.id, status: job.status, input });
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    console.error("animate failed", e);
    return Response.json({ error: "Could not submit the video job to Runpod." }, { status: 502 });
  }
}
