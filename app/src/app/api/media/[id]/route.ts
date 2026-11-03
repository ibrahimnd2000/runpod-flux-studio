import { checkCode, LimitError } from "@/lib/limits";
import { deleteImage, isValidId, readMedia } from "@/lib/media";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const file = isValidId(id) ? readMedia(id) : null;
  if (!file) return Response.json({ error: "File not found." }, { status: 404 });
  const { bytes, mime, kind } = file;
  const download = new URL(req.url).searchParams.has("download");
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    // Files never change once generated; a deleted id simply stops resolving.
    "Cache-Control": "public, max-age=31536000, immutable",
    ...(download
      ? { "Content-Disposition": `attachment; filename="flux-${id}.${kind === "video" ? "mp4" : "jpg"}"` }
      : {}),
  };

  // <video> seeks with Range requests (Safari requires them).
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const size = bytes.length;
    const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Length": String(bytes.length) } });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    checkCode(req.headers.get("x-access-code"));
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (!isValidId(id)) return Response.json({ error: "Invalid image id." }, { status: 400 });
  try {
    if (!deleteImage(id)) return Response.json({ error: "File not found." }, { status: 404 });
  } catch (e) {
    console.error(`could not delete image ${id}`, e);
    return Response.json({ error: "Could not delete the image from storage." }, { status: 500 });
  }
  return Response.json({ deleted: id });
}
