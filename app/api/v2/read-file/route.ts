import { NextRequest, after } from "next/server";
import OpenAI from "openai";
import { verifyToken } from "@/lib/verifyToken";
import { track, costUsd, sessionOf } from "@/lib/v2/track";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse");

export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024; // Vercel request limit is 4.5MB; images are resized in the browser
const MAX_TEXT = 8000;

const IMAGE_PROMPT = `זו תמונה שבעל מקצוע העלה כדי ליצור ממנה הצעת מחיר: הצעה ישנה, כתב יד, צילום מסך של הודעה, רשימת עבודות, תוכנית וכו'.
כתוב בעברית, כטקסט פשוט, את כל מה שרלוונטי להצעת מחיר: שם לקוח, טלפון, כתובת, עבודות/פריטים, כמויות, יחידות, מחירים, סכום כולל, מע"מ, הנחות, תנאים והערות.
העתק מספרים בדיוק כפי שהם. אל תמציא ואל תשלים מה שלא כתוב. אם התמונה לא קשורה להצעת מחיר — כתוב רק: NOT_A_QUOTE`;

/**
 * POST /api/v2/read-file — multipart: file=<pdf | image>. Auth: Authorization: Bearer <JWT>.
 * Returns { text }: the document's content as plain text, which the page then sends to
 * /api/v2/chat as a user message — the same path as typing or recording.
 */
export async function POST(req: NextRequest) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const v = verifyToken(bearer);
  if (!v.valid) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!file) return Response.json({ error: "missing_file" }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "too_large" }, { status: 413 });

  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isImage = file.type.startsWith("image/");
  const report = (error: string | null, cost?: number) =>
    after(() => track({ event: "file_read", user_id: v.payload.user_id, session_id: sessionOf(req), cost_usd: cost, props: { kind: isPdf ? "pdf" : isImage ? "image" : "other", ok: !error, error } }));

  try {
    if (isPdf) {
      const result = await pdfParse(Buffer.from(await file.arrayBuffer()));
      const text = String(result.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
      // A scanned PDF has no text layer — ask for a photo instead.
      report(text.length < 20 ? "scanned_pdf" : null);
      if (text.length < 20) return Response.json({ error: "scanned_pdf" }, { status: 422 });
      return Response.json({ text: text.slice(0, MAX_TEXT) });
    }

    if (isImage) {
      if (!process.env.OPENAI_API_KEY) return Response.json({ error: "not_configured" }, { status: 503 });
      const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0,
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: IMAGE_PROMPT },
            { type: "image_url", image_url: { url: `data:${file.type};base64,${b64}` } },
          ],
        }],
      });
      const text = (completion.choices[0]?.message?.content ?? "").trim();
      const notQuote = !text || text.includes("NOT_A_QUOTE");
      report(notQuote ? "not_a_quote" : null, costUsd("gpt-4o", completion.usage));
      if (notQuote) return Response.json({ error: "not_a_quote" }, { status: 422 });
      return Response.json({ text: text.slice(0, MAX_TEXT) });
    }

    return Response.json({ error: "unsupported_type" }, { status: 415 });
  } catch (err) {
    console.error("[v2/read-file] error:", err instanceof Error ? err.message : err);
    report("read_failed");
    return Response.json({ error: "read_failed" }, { status: 502 });
  }
}
