import { checkCode, LimitError } from "@/lib/limits";
import { deleteLora, refreshLora } from "@/lib/loras";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const lora = await refreshLora(id);
    return lora ? Response.json(lora) : Response.json({ error: "Unknown LoRA." }, { status: 404 });
  } catch (e) {
    console.error("LoRA status failed", e);
    return Response.json({ error: "Could not reach Runpod." }, { status: 502 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkCode(req.headers.get("x-access-code"));
    const { id } = await params;
    return deleteLora(id) ? Response.json({ deleted: id }) : Response.json({ error: "Unknown LoRA." }, { status: 404 });
  } catch (e) {
    if (e instanceof LimitError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
