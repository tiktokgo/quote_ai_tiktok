import { NextRequest, after } from "next/server";
import OpenAI from "openai";
import { safeEqual } from "@/lib/auth";
import { transcribeWithUsage } from "@/lib/voiceQuote";
import { track, costUsd } from "@/lib/v2/track";
import { runTurn } from "@/lib/wa/ai";
import { lookupUser, saveQuote } from "@/lib/wa/bubble";
import { reply, endConversation, hasSavedFlow, lastInput } from "@/lib/wa/manychat";
import { loadSession, saveSession, deleteSession } from "@/lib/wa/session";
import { formatSummary } from "@/lib/wa/summary";
import { isVoiceUrl, downloadVoice } from "@/lib/wa/audio";

// Transcription + up to 3 gpt-4o calls, after the response was sent.
export const maxDuration = 60;

/**
 * POST /api/wa/message — called by a ManyChat External Request (tiktok-hq/docs/whatsapp-quote.md).
 * Header x-wa-secret: WA_WEBHOOK_SECRET.
 * Body: { contact_id, text?, audio_url?, action?: "start" | "save" | "cancel" | "message" }
 * action "message" = read the last message from ManyChat (the Default Reply router sends this).
 * Answers at once ({ ok: true }) and replies on WhatsApp through the ManyChat API,
 * because ManyChat stops waiting after ~10s.
 */

const SIGNUP_URL = () => process.env.WA_SIGNUP_URL || "https://app.tik-tok.co.il";

const T = {
  start: "🎤 ספרו לי על הצעת המחיר: למי, מה העבודה וכמה זה עולה. אפשר לכתוב או להקליט.",
  noAccount: () => `כדי ליצור הצעת מחיר מוואטסאפ צריך משתמש בתיקתוק, עם מספר הטלפון הזה.\nפותחים כאן, בחינם: ${SIGNUP_URL()}`,
  upgrade: "ניצלת את 5 ההצעות החינמיות. כדי להמשיך ליצור הצעות עם AI, אפשר לשדרג את המנוי באפליקציה של תיקתוק.",
  noSpeech: "לא הצלחתי לשמוע את ההקלטה 🙈 אפשר לנסות שוב, או לכתוב.",
  nothingToSave: "עוד אין הצעה לשמור. ספרו לי למי ההצעה ומה העבודה.",
  saved: (url?: string) =>
    `✅ הצעת המחיר נשמרה כטיוטה בתיקתוק.${url ? `\nלצפייה, עריכה ושליחה ללקוח:\n${url}` : ""}\n\n` +
    (hasSavedFlow() ? "רוצים להכין עוד הצעה? 👇" : "רוצים להכין עוד הצעה? כתבו \"התחלה\"."),
  cancelled: "ההצעה בוטלה. כדי להתחיל חדשה כתבו \"התחלה\".",
  expired: "ההצעה הזו כבר לא פתוחה. כדי להתחיל חדשה כתבו \"התחלה\".",
  error: "משהו השתבש אצלנו 😕 נסו שוב בעוד רגע.",
};

// Typed words that act like the buttons.
const SAVE_WORDS = /^(שמור|לשמור|שמירה|אישור|מאשר|מאשרת)[.!]?$/;
const CANCEL_WORDS = /^(ביטול|בטל|לבטל)[.!]?$/;

interface Body {
  contact_id?: unknown;
  text?: unknown;
  audio_url?: unknown;
  action?: unknown;
}

export async function POST(req: NextRequest) {
  const secret = process.env.WA_WEBHOOK_SECRET;
  if (!secret) return Response.json({ ok: false, error: "not_configured" }, { status: 503 });
  if (!safeEqual(req.headers.get("x-wa-secret") ?? "", secret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const contactId = String(body.contact_id ?? "").trim();
  if (!/^\d{1,20}$/.test(contactId)) return Response.json({ ok: false, error: "bad_contact_id" }, { status: 400 });
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const action = str(body.action);
  if (action && !["start", "save", "cancel", "message"].includes(action)) return Response.json({ ok: false, error: "bad_action" }, { status: 400 });
  const msg = action === "message" ? null : toMessage(str(body.text), str(body.audio_url), action);
  if (msg && !msg.action && !msg.text && !msg.audioUrl) return Response.json({ ok: false, error: "empty" }, { status: 400 });

  after(() => handle(contactId, msg));
  return Response.json({ ok: true });
}

type Msg = { text: string; audioUrl: string; action: string };

function toMessage(text: string, audioUrl: string, action: string): Msg {
  text = text.slice(0, 4000);
  // ManyChat hands us a voice note as the "text" of the message.
  if (!audioUrl && isVoiceUrl(text)) { audioUrl = text; text = ""; }
  if (!action && SAVE_WORDS.test(text)) action = "save";
  if (!action && CANCEL_WORDS.test(text)) action = "cancel";
  return { text, audioUrl, action };
}

/**
 * msg null = action "message": read the user's last message from ManyChat ourselves.
 * Putting it in the External Request body breaks the JSON when it has a quote (מע"מ) or a line break.
 */
async function handle(contactId: string, incoming: Msg | null) {
  let userId: string | undefined;
  let cost = 0;
  let msg: Msg = incoming ?? { text: "", audioUrl: "", action: "" };
  const report = (props: Record<string, string | number | boolean | null>) =>
    track({ event: "wa_message", user_id: userId, session_id: `wa:${contactId}`, cost_usd: cost || undefined, props: { ...props, voice: !!msg.audioUrl, action: msg.action || null } });
  try {
    if (!incoming) {
      msg = toMessage((await lastInput(contactId)).trim(), "", "");
      if (!msg.action && !msg.text && !msg.audioUrl) return report({ result: "empty" });
    }
    const user = await lookupUser(contactId);
    if (!user) { await reply(contactId, T.noAccount()); await endConversation(contactId); return report({ result: "no_account" }); }
    userId = user.userId;
    if (!user.canContinue) { await reply(contactId, T.upgrade); await endConversation(contactId); return report({ result: "over_limit" }); }

    if (msg.action === "start") {
      // An empty row marks the conversation as open; without one, messages go back to support (below).
      await saveSession({ contact_id: contactId, user_id: user.userId, messages: [], quote: {} });
      await reply(contactId, T.start);
      return report({ result: "started" });
    }
    if (msg.action === "cancel") {
      await deleteSession(contactId);
      await reply(contactId, T.cancelled);
      await endConversation(contactId);
      return report({ result: "cancelled" });
    }

    const session = await loadSession(contactId, user.userId);
    // No open conversation (a day without activity, or ManyChat still "on" from before):
    // no answer, the message stays in Live Chat for a person.
    // The save button of an old summary still gets an answer.
    if (!session) {
      if (msg.action === "save") await reply(contactId, T.expired);
      await endConversation(contactId);
      return report({ result: "no_session" });
    }

    if (msg.action === "save") {
      if (!session.quote.items?.length) { await reply(contactId, T.nothingToSave); return report({ result: "nothing_to_save" }); }
      const saved = await saveQuote(session.quote, user.userId);
      await deleteSession(contactId);
      await reply(contactId, T.saved(saved.url), "saved");
      await endConversation(contactId);
      return report({ result: "saved", mode: session.quote.pricing_mode ?? null, items: session.quote.items.length });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let said = msg.text;
    if (msg.audioUrl) {
      const audio = await downloadVoice(msg.audioUrl);
      const t = await transcribeWithUsage(openai, audio, user.industry || undefined);
      cost += costUsd("gpt-4o-transcribe", t.usage) ?? 0;
      said = [said, t.text].filter(Boolean).join("\n");
      if (!said) { await reply(contactId, T.noSpeech); return report({ result: "no_speech" }); }
    }

    session.messages.push({ role: "user", content: said });
    const ctx = { company_name: user.companyName || "העסק", industry: user.industry || "כללי", user_id: user.userId };
    const turn = await runTurn(openai, ctx, session.messages, session.quote);
    cost += turn.cost;
    session.messages.push({ role: "assistant", content: turn.text });
    session.quote = turn.quote;
    await saveSession(session);

    const hasQuote = !!session.quote.items?.length;
    if (turn.updated && hasQuote) await reply(contactId, formatSummary(session.quote, turn.text), "summary");
    else await reply(contactId, turn.text);
    return report({ result: "ai_reply", updated: turn.updated, items: session.quote.items?.length ?? 0, turn: session.messages.length, ...turn.flags });
  } catch (err) {
    console.error("[wa/message] error:", err instanceof Error ? err.message : err);
    await reply(contactId, T.error).catch(() => {});
    return report({ result: "error" });
  }
}
