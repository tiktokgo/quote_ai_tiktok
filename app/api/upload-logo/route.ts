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

  if (!file.type.startsWith("image/")) {
    return new Response(JSON.stringify({ ok: false, message: "Images only" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const ext = file.name.split(".").pop() ?? "png";
    const filename = `logos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const blob = await put(filename, file, { access: "public" });
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
