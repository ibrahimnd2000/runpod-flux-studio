import { acceptUpload, LORA_LIMITS, readLoraFile } from "@/lib/loras";
import { LimitError } from "@/lib/limits";

// GET: the image worker downloads a ready adapter here (ids are unguessable and
// the weights are not secret). PUT: the training worker uploads it, once, with the
// one-time token it was given in the job.

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = readLoraFile(id);
  if (!file) return Response.json({ error: "No such LoRA file." }, { status: 404 });
  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.length),
      "Content-Disposition": `attachment; filename="${id}.safetensors"`,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > LORA_LIMITS.maxBytes) throw new LimitError("The adapter file is too large.", 413);
    acceptUpload(id, req.headers.get("x-upload-token"), Buffer.from(await req.arrayBuffer()));
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    console.error("LoRA upload failed", e);
    return Response.json({ error: "Could not store the adapter." }, { status: 500 });
  }
}
