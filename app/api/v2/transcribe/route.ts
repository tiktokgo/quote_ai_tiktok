import { NextRequest, after } from "next/server";
import OpenAI from "openai";
import { verifyToken } from "@/lib/verifyToken";
import { transcribeWithUsage } from "@/lib/voiceQuote";
import { track, costUsd, sessionOf } from "@/lib/v2/track";
import { bearerOf, verifyGuestToken, takeGuestUse, GUEST_USER_ID, GUEST_MAX_AUDIO_BYTES } from "@/lib/v2/guest";

// Transcription of a few minutes of speech usually takes 3–10s.
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // Vercel request limit is 4.5MB (~4 min of opus)

/**
 * POST /api/v2/transcribe — multipart: audio=<file>. Auth: Authorization: Bearer <JWT>.
 * Returns { text }. The text then goes to /api/v2/chat like a typed message.
 * Same model and prompt as /api/voice-quote (tested on the Bubble voice_test page).
 */
export async function POST(req: NextRequest) {
  const bearer = bearerOf(req);
  const v = verifyToken(bearer);
  // Guests (marketing site): one recording of up to 20 seconds — see lib/v2/guest.ts.
  const gid = v.valid ? null : verifyGuestToken(bearer);
  if (!v.valid && !gid) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "not_configured" }, { status: 503 });
  const userId = v.valid ? v.payload.user_id : GUEST_USER_ID;
  const industry = v.valid ? v.payload.industry : undefined;

  let audio: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("audio");
    if (f instanceof File) audio = f;
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!audio) return Response.json({ error: "missing_audio" }, { status: 400 });
  if (audio.size > MAX_AUDIO_BYTES) return Response.json({ error: "too_long" }, { status: 413 });
  if (audio.size < 1000) return Response.json({ error: "empty" }, { status: 400 });
  if (gid) {
    if (audio.size > GUEST_MAX_AUDIO_BYTES) return Response.json({ error: "too_long" }, { status: 413 });
    if (!(await takeGuestUse(req, gid, "voice", sessionOf(req)))) return Response.json({ error: "guest_limit" }, { status: 429 });
  }

  // Browsers sometimes report an empty type; give OpenAI a filename extension it recognizes.
  if (!/\.(webm|mp4|m4a|mp3|ogg|oga|wav|mpeg|mpga|flac)$/i.test(audio.name)) {
    const ext = audio.type.includes("mp4") ? "mp4" : audio.type.includes("ogg") ? "ogg" : "webm";
    audio = new File([audio], `recording.${ext}`, { type: audio.type || `audio/${ext}` });
  }

  const kb = Math.round(audio.size / 1024);
  const report = (props: Record<string, string | number | boolean>, cost?: number) =>
    after(() => track({ event: "transcribed", user_id: userId, session_id: sessionOf(req), cost_usd: cost, props: { kb, ...props, ...(gid ? { guest: true } : {}) } }));
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { text, usage } = await transcribeWithUsage(openai, audio, industry);
    report({ ok: !!text, chars: text.length }, costUsd("gpt-4o-transcribe", usage));
    if (!text) return Response.json({ error: "no_speech" }, { status: 422 });
    return Response.json({ text });
  } catch (err) {
    console.error("[v2/transcribe] error:", err instanceof Error ? err.message : err);
    report({ ok: false, error: "transcribe_failed" });
    return Response.json({ error: "transcribe_failed" }, { status: 502 });
  }
}
