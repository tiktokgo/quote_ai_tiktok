import { NextRequest } from "next/server";
import { put } from "@vercel/blob";
import { userIdFromRequest } from "@/lib/auth";

/**
 * POST /api/v2/upload-photo — multipart: file=<image>. Auth: Authorization: Bearer <JWT>.
 * Stores a site photo in Vercel Blob and returns { url }. The page resizes photos before upload.
 */

// Extension and content type from an allowlist — never from the client's file name. No SVG (scripts).
const EXT_BY_TYPE: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_BYTES = 4 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const auth = userIdFromRequest(req);
  if (!auth.ok) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let file: File | null = null;
  try {
    const f = (await req.formData()).get("file");
    if (f instanceof File) file = f;
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!file) return Response.json({ error: "missing_file" }, { status: 400 });
  const ext = EXT_BY_TYPE[file.type];
  if (!ext) return Response.json({ error: "unsupported_type" }, { status: 415 });
  if (file.size > MAX_BYTES) return Response.json({ error: "too_large" }, { status: 413 });

  try {
    const safeUser = auth.userId.replace(/[^\w-]/g, "").slice(0, 40) || "user";
    const name = `quote-photos/${safeUser}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const blob = await put(name, file, { access: "public", contentType: file.type });
    return Response.json({ url: blob.url });
  } catch (err) {
    console.error("[v2/upload-photo] error:", err instanceof Error ? err.message : err);
    return Response.json({ error: "upload_failed" }, { status: 502 });
  }
}
