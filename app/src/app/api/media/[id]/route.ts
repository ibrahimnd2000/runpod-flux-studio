import { checkCode, LimitError } from "@/lib/limits";
import { deleteImage, isValidId, readImage } from "@/lib/media";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const bytes = isValidId(id) ? readImage(id) : null;
  if (!bytes) return Response.json({ error: "Image not found." }, { status: 404 });
  const download = new URL(req.url).searchParams.has("download");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.length),
      // Images never change once generated; a deleted id simply stops resolving.
      "Cache-Control": "public, max-age=31536000, immutable",
      ...(download ? { "Content-Disposition": `attachment; filename="flux-${id}.jpg"` } : {}),
    },
  });
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
    if (!deleteImage(id)) return Response.json({ error: "Image not found." }, { status: 404 });
  } catch (e) {
    console.error(`could not delete image ${id}`, e);
    return Response.json({ error: "Could not delete the image from storage." }, { status: 500 });
  }
  return Response.json({ deleted: id });
}
