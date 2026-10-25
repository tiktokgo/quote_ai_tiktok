import { NextRequest } from "next/server";
import { put } from "@vercel/blob";

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return new Response(JSON.stringify({ ok: false, message: "No file" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // SECURITY: the extension and content type come from an allowlist — never
  // from the client's file name (x.html with type image/png used to be stored
  // as a public HTML page). SVG is excluded: it can carry scripts.
  const EXT_BY_TYPE: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const ext = EXT_BY_TYPE[file.type];
  if (!ext) {
    return new Response(JSON.stringify({ ok: false, message: "Images only (PNG, JPG, WEBP, GIF)" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (file.size > 5 * 1024 * 1024) {
    return new Response(JSON.stringify({ ok: false, message: "File too large (max 5MB)" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const filename = `logos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const blob = await put(filename, file, { access: "public", contentType: file.type });
    console.log("[upload-logo] uploaded:", blob.url);
    return new Response(JSON.stringify({ ok: true, url: blob.url }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[upload-logo] error:", msg);
    return new Response(JSON.stringify({ ok: false, message: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
