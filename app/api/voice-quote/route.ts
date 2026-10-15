import { NextRequest } from "next/server";
import OpenAI from "openai";
import { verifyToken } from "@/lib/verifyToken";
import { extractQuote, transcribe } from "@/lib/voiceQuote";

// Transcription + extraction usually take 5–15s.
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // Vercel request limit is 4.5MB (~4 min of opus)

/**
 * POST /api/voice-quote — DRY RUN: returns the quote JSON, does not call Bubble yet.
 *
 * Auth (one of):
 *   Authorization: Bearer <JWT from /api/token>   — the app (Bubble HTML element)
 *   x-api-key: <TOKEN_API_KEY>                     — server-to-server (ManyChat, tests)
 *
 * Body (one of):
 *   multipart/form-data: audio=<file>, [request_id]
 *   application/json:    { audio_url } | { text }, [request_id], [industry]
 */

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const list = (process.env.VOICE_ALLOWED_ORIGINS ?? "https://app.tik-tok.co.il")
    .split(",")
    .map((s) => s.trim());
  return list.includes(origin) ? origin : null;
}

function json(req: NextRequest, body: unknown, status = 200) {
  const origin = allowedOrigin(req.headers.get("origin"));
  return Response.json(body, {
    status,
    headers: origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {},
  });
}

export async function OPTIONS(req: NextRequest) {
  const origin = allowedOrigin(req.headers.get("origin"));
  return new Response(null, {
    status: 204,
    headers: origin
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        }
      : {},
  });
}

export async function POST(req: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return json(req, { ok: false, error: "OPENAI_API_KEY not configured" }, 503);
  }

  // ── Auth ──
  let industry: string | undefined;
  let userId: string | undefined;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const apiKey = req.headers.get("x-api-key");
  if (bearer) {
    const v = verifyToken(bearer);
    if (!v.valid) return json(req, { ok: false, error: v.reason }, 401);
    industry = v.payload.industry;
    userId = v.payload.user_id;
  } else if (!apiKey || !process.env.TOKEN_API_KEY || apiKey !== process.env.TOKEN_API_KEY) {
    return json(req, { ok: false, error: "Unauthorized" }, 401);
  }

  // ── Input ──
  let audio: File | null = null;
  let text: string | null = null;
  let requestId: string | null = null;
  const ctype = req.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      const f = form.get("audio");
      if (f instanceof File) audio = f;
      requestId = (form.get("request_id") as string | null) ?? null;
    } else {
      const body = (await req.json()) as {
        audio_url?: string;
        text?: string;
        request_id?: string;
        industry?: string;
      };
      requestId = body.request_id ?? null;
      if (!industry && body.industry) industry = body.industry;
      if (body.text?.trim()) {
        text = body.text.trim();
      } else if (body.audio_url) {
        if (!/^https:\/\//i.test(body.audio_url)) {
          return json(req, { ok: false, error: "audio_url must be https" }, 400);
        }
        const r = await fetch(body.audio_url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return json(req, { ok: false, error: `audio_url fetch failed (${r.status})` }, 400);
        const blob = await r.blob();
        const name = new URL(body.audio_url).pathname.split("/").pop() || "audio.ogg";
        audio = new File([blob], name, { type: blob.type || "audio/ogg" });
      }
    }
  } catch {
    return json(req, { ok: false, error: "Invalid request body" }, 400);
  }

  if (!audio && !text) return json(req, { ok: false, error: "Missing audio, audio_url or text" }, 400);
  if (audio && audio.size > MAX_AUDIO_BYTES) {
    return json(req, { ok: false, error: "Recording too long" }, 413);
  }
  if (audio && audio.size < 1000) {
    return json(req, { ok: false, error: "Recording is empty" }, 400);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const started = Date.now();

  try {
    // Browsers sometimes report an empty type; give OpenAI a filename extension it recognizes.
    if (audio && !/\.(webm|mp4|m4a|mp3|ogg|oga|wav|mpeg|mpga|flac)$/i.test(audio.name)) {
      const ext = audio.type.includes("mp4") ? "mp4" : audio.type.includes("ogg") ? "ogg" : "webm";
      audio = new File([audio], `recording.${ext}`, { type: audio.type || `audio/${ext}` });
    }
    const transcript = text ?? (await transcribe(openai, audio!, industry));
    const tTranscribe = Date.now() - started;

    if (!transcript) {
      return json(req, { ok: false, error: "not_a_quote", transcript }, 422);
    }
    const quote = await extractQuote(openai, transcript, industry);
    const ms = { transcribe: tTranscribe, total: Date.now() - started };
    console.log(`[voice-quote] mode:${quote?.pricing_mode ?? "none"} ms:${JSON.stringify(ms)}`);

    if (!quote) return json(req, { ok: false, error: "not_a_quote", transcript }, 422);

    return json(req, {
      ok: true,
      dry_run: true,
      request_id: requestId,
      user_id: userId ?? null,
      target: quote.pricing_mode === "total" ? "API1_total" : "API2_per_item",
      transcript,
      quote,
      ms,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[voice-quote] error:", msg);
    return json(req, { ok: false, error: msg }, 500);
  }
}
