import { NextRequest, after } from "next/server";
import OpenAI from "openai";
import { safeEqual } from "@/lib/auth";
import { transcribeWithUsage } from "@/lib/voiceQuote";
import { track, costUsd } from "@/lib/v2/track";
import { runTurn } from "@/lib/wa/ai";
import { lookupUser, saveQuote, addExpense, createTask } from "@/lib/wa/bubble";
import { reply, endConversation, startConversation, hasSavedFlow, hasChoiceFlow, hasTaskFlow, lastInput } from "@/lib/wa/manychat";
import { loadSession, saveSession, deleteSession } from "@/lib/wa/session";
import type { WaSession } from "@/lib/wa/session";
import { formatSummary } from "@/lib/wa/summary";
import { isVoiceUrl, downloadVoice, fileKind } from "@/lib/wa/audio";
import { routerMode, classify, isReceiptImage } from "@/lib/wa/router";
import { burstCount, answeredRecently, firstInBurst } from "@/lib/wa/batch";
import { extractTask, formatTask } from "@/lib/wa/task";
import type { WaUser } from "@/lib/wa/bubble";

// Transcription + up to 3 gpt-4o calls, after the response was sent. An expense waits ~15s for the rest of a burst (the first file is answered at once).
export const maxDuration = 60;

/**
 * POST /api/wa/message — called by a ManyChat External Request (tiktok-hq/docs/whatsapp-quote.md).
 * Header x-wa-secret: WA_WEBHOOK_SECRET.
 * Body: { contact_id, text?, audio_url?, action?: "start" | "save" | "cancel" | "message" | "assist" | "human" }
 * "assist" / "human" = the router's buttons when it was not sure (MANYCHAT_FLOW_CHOICE).
 * WA_ROUTER_MODE (lib/wa/router.ts) decides what happens to a message outside an open quote.
 * action "message" = read the last message from ManyChat (the Default Reply router sends this).
 * Answers at once ({ ok: true }) and replies on WhatsApp through the ManyChat API,
 * because ManyChat stops waiting after ~10s.
 */

const SIGNUP_URL = () => process.env.WA_SIGNUP_URL || "https://app.tik-tok.co.il";
const PURCHASE_URL = () => process.env.WA_PURCHASE_URL || "https://app.tik-tok.co.il/purchase";
/** The "what can I do here" menu goes to the same contact at most once a month. */
const MENU_EVERY_MS = 30 * 24 * 3600 * 1000;

const T = {
  start: "🎤 ספרו לי על הצעת המחיר: למי, מה העבודה וכמה זה עולה. אפשר לכתוב או להקליט.",
  noAccount: () => `כדי ליצור הצעת מחיר מוואטסאפ צריך משתמש בתיקתוק, עם מספר הטלפון הזה.\nפותחים כאן, בחינם: ${SIGNUP_URL()}`,
  upgrade: `ניצלת את 5 ההצעות החינמיות. כדי להמשיך ליצור הצעות עם AI, אפשר לשדרג את המנוי באפליקציה של תיקתוק או דרך הקישור הבא:
${PURCHASE_URL()}`,
  noSpeech: "לא הצלחתי לשמוע את ההקלטה 🙈 אפשר לנסות שוב, או לכתוב.",
  nothingToSave: "עוד אין הצעה לשמור. ספרו לי למי ההצעה ומה העבודה.",
  saved: (url?: string) =>
    `✅ הצעת המחיר נשמרה כטיוטה בתיקתוק.${url ? `\nלצפייה, עריכה ושליחה ללקוח:\n${url}` : ""}\n\n` +
    (hasSavedFlow() ? "רוצים להכין עוד הצעה? 👇" : "רוצים להכין עוד הצעה? כתבו \"התחלה\"."),
  cancelled: "ההצעה בוטלה. כדי להתחיל חדשה כתבו \"התחלה\".",
  expired: "ההצעה הזו כבר לא פתוחה. כדי להתחיל חדשה כתבו \"התחלה\".",
  error: "משהו השתבש אצלנו 😕 נסו שוב בעוד רגע.",
  fileInQuote: "📎 קיבלתי קובץ, אבל באמצע הצעת מחיר אפשר רק לכתוב או להקליט.\nכדי לשמור את הקובץ כהוצאה, כתבו \"הוצאה\" ושלחו אותו שוב.",
  // Router (WA_ROUTER_MODE=on)
  choice: "לא הייתי בטוח מה צריך 🙂 להכין הצעת מחיר, או להעביר לנציג?",
  human: "👤 העברתי לנציג, נחזור אליך כאן בהקדם.",
  assistStale: "🙂 כתבו או הקליטו מה צריך, למשל \"תכין לי הצעה ל...\", ואני על זה.",
  sendFile: "📎 שלחו כאן תמונה או PDF של הקבלה, ואני אוסיף אותה להוצאות.",
  expenseFirst: "✅ התקבל! אפשר לשלוח עוד, גם כמה ביחד 📎",
  expenseTotal: (n: number) => `✅ סה״כ התקבלו ${n} קבצים`,
  expenseLimit: `ניצלת את 5 המסמכים החינמיים. כדי להמשיך להוסיף הוצאות מוואטסאפ, אפשר לשדרג את המנוי באפליקציה של תיקתוק או דרך הקישור הבא:
${PURCHASE_URL()}`,
  expenseNoUser: "לא מצאנו חשבון תיקתוק שמחובר לוואטסאפ הזה 🙁 פנו אלינו ונסדר את זה",
  // Tasks and meetings (phase 2)
  taskSaved: "✅ נשמר במשימות שלך בתיקתוק.",
  taskCancelled: "בוטל, לא נשמר כלום.",
  fileInTask: "📎 קיבלתי קובץ, אבל עכשיו אנחנו באמצע משימה. כתבו \"שמור\" או \"ביטול\", ואז שלחו את הקובץ שוב.",
  // A support message, once per MENU_EVERY_MS per contact.
  menu: `היי 👋 קיבלנו את ההודעה, ונציג אמיתי (לא בוט 🙂) יחזור אליך בהקדם.

אגב, כאן בוואטסאפ אפשר גם:
📝 *הצעת מחיר*: לכתוב או להקליט, למשל "תכין הצעה לצביעת דירה ל..."
🧾 *הוצאה*: לשלוח צילום של קבלה, והיא נכנסת להוצאות העסק
📅 *משימה או פגישה*: "תזכיר לי מחר בעשר להתקשר לדני", והיא נכנסת ליומן`,
  menuUpgrade: `💎 ניצלת את 5 ההצעות החינמיות. כדי להמשיך להכין הצעות, אפשר לשדרג כאן: ${PURCHASE_URL()}`,
  // No account linked to this number: maybe there is one on another number (a person links it).
  menuNoAccount: () => `היי 👋 קיבלנו את ההודעה, ונציג אמיתי (לא בוט 🙂) יחזור אליך בהקדם.

לא מצאנו חשבון תיקתוק שמחובר למספר הזה.
• *כבר יש לך חשבון?* הנציג יחבר אותו
• *עוד אין?* פותחים כאן בחינם: ${SIGNUP_URL()}

עם חשבון, אפשר כאן בוואטסאפ:
📝 הצעת מחיר, בכתב או בהקלטה
🧾 הוצאה: צילום של קבלה
📅 משימה או פגישה ביומן`,
};

// Typed words that act like the buttons.
const SAVE_WORDS = /^(שמור|לשמור|שמירה|אישור|מאשר|מאשרת)[.!]?$/;
const CANCEL_WORDS = /^(ביטול|בטל|לבטל)[.!]?$/;
const ACTIONS = ["start", "save", "cancel", "message", "assist", "human"];
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
  if (action && !ACTIONS.includes(action)) return Response.json({ ok: false, error: "bad_action" }, { status: 400 });
  const msg = action === "message" ? null : toMessage(str(body.text), str(body.audio_url), action);
  if (msg && !msg.action && !msg.text && !msg.audioUrl && !msg.fileUrl) return Response.json({ ok: false, error: "empty" }, { status: 400 });

  after(() => handle(contactId, msg));
  return Response.json({ ok: true });
}

/** fileUrl = an image or PDF the user sent (a possible expense) — never sent to transcription. */
type Msg = { text: string; audioUrl: string; fileUrl: string; action: string };

function toMessage(text: string, audioUrl: string, action: string): Msg {
  text = text.slice(0, 4000);
  let fileUrl = "";
  // ManyChat hands us a voice note, an image or a PDF as the "text" of the message.
  if (!audioUrl && isVoiceUrl(text)) {
    const kind = fileKind(text);
    if (kind === "image" || kind === "pdf") fileUrl = text;
    else audioUrl = text;
    text = "";
  }
  if (!action && SAVE_WORDS.test(text)) action = "save";
  if (!action && CANCEL_WORDS.test(text)) action = "cancel";
  return { text, audioUrl, fileUrl, action };
}

/**
 * WA_ROUTER_MODE=shadow: where a message outside a quote would go. Logged only — no answer,
 * no Bubble call. Never throws: a router failure must not reach the user.
 */
async function shadowRoute(msg: Msg, user: WaUser | null): Promise<{ props: Record<string, string | number | null>; cost: number }> {
  if (!user) return { props: { route: "non_user" }, cost: 0 };
  if (msg.fileUrl && fileKind(msg.fileUrl) !== "image") return { props: { route: "expense", why: "file", kind: "pdf" }, cost: 0 };
  if (msg.fileUrl) {
    // Users also send screenshots of a problem to support: only a receipt is an expense.
    try {
      const r = await isReceiptImage(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), msg.fileUrl);
      return { props: { route: r.receipt ? "expense" : "support", why: r.receipt ? "receipt" : "not_receipt", kind: "image" }, cost: r.cost };
    } catch (err) {
      console.error("[wa/router] receipt check failed:", err instanceof Error ? err.message : err);
      return { props: { route: null, why: "error", kind: "image" }, cost: 0 };
    }
  }
  if (!msg.text && !msg.audioUrl) return { props: { route: null }, cost: 0 };
  let cost = 0;
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let said = msg.text;
    if (msg.audioUrl) {
      const t = await transcribeWithUsage(openai, await downloadVoice(msg.audioUrl), user.industry || undefined);
      cost += costUsd("gpt-4o-transcribe", t.usage) ?? 0;
      said = [said, t.text].filter(Boolean).join("\n");
    }
    if (!said) return { props: { route: null, why: "no_speech" }, cost };
    const c = await classify(openai, said);
    cost += c.cost;
    return { props: { route: c.route, confidence: Math.round(c.confidence * 100) / 100 }, cost };
  } catch (err) {
    console.error("[wa/router] shadow failed:", err instanceof Error ? err.message : err);
    return { props: { route: null, why: "error" }, cost };
  }
}


/**
 * msg null = action "message": read the user's last message from ManyChat ourselves.
 * Putting it in the External Request body breaks the JSON when it has a quote (מע"מ) or a line break.
 */
async function handle(contactId: string, incoming: Msg | null) {
  let userId: string | undefined;
  let cost = 0;
  let msg: Msg = incoming ?? { text: "", audioUrl: "", fileUrl: "", action: "" };
  const report = (props: Record<string, string | number | boolean | null>) => {
    const c = cost;
    cost = 0; // an expense reports twice (saved, then replied): count the cost once
    return track({ event: "wa_message", user_id: userId, session_id: `wa:${contactId}`, cost_usd: c || undefined, props: { ...props, voice: !!msg.audioUrl, file: !!msg.fileUrl, action: msg.action || null } });
  };
  // With the router on, ManyChat sends us every message, not only after "התחלה".
  // Then "no account" and "upgrade" answer only quote actions, not every support question.
  const mode = routerMode(contactId);
  const quoteOnly = mode === "off";
  const shadow = async (result: string, user: WaUser | null) => {
    const r = await shadowRoute(msg, user);
    cost += r.cost;
    return report({ result, router: "shadow", ...r.props });
  };
  // A routed message that fails before we decided to answer stays with support, with no error text.
  let speak = true;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    if (!incoming) {
      msg = toMessage((await lastInput(contactId)).trim(), "", "");
      if (!msg.action && !msg.text && !msg.audioUrl && !msg.fileUrl) return report({ result: "empty" });
    }
    const user = await lookupUser(contactId);
    if (!user) {
      if (quoteOnly || msg.action === "start") { await reply(contactId, T.noAccount()); await endConversation(contactId); return report({ result: "no_account" }); }
      if (mode === "shadow") return shadow("no_account_silent", null);
      // A typed message from a number with no linked account: "a person will answer" + how to open
      // (or link) an account, once a month. Not to an auto-reply, not when the router is unsure, not to files.
      if (mode === "on" && !msg.action && msg.text && !msg.fileUrl) {
        speak = false;
        try {
          const c = await classify(openai, msg.text);
          cost += c.cost;
          const props = { route: c.route, confidence: Math.round(c.confidence * 100) / 100, router: "on" };
          if (c.route !== "auto_reply" && c.route !== "unsure" && !(await answeredRecently(contactId, "menu", MENU_EVERY_MS))) {
            await reply(contactId, T.menuNoAccount());
            return report({ result: "menu", why: "no_account", ...props });
          }
          return report({ result: "no_account_silent", ...props });
        } catch (err) {
          console.error("[wa/message] no-account menu failed:", err instanceof Error ? err.message : err);
        }
      }
      return report({ result: "no_account_silent", router: mode });
    }
    userId = user.userId;
    const overLimit = async () => { await reply(contactId, T.upgrade); await endConversation(contactId); return report({ result: "over_limit" }); };
    if (!user.canContinue && (quoteOnly || msg.action === "start")) return overLimit();

    /** Text + transcript of the voice note. "" = nothing heard. */
    const hear = async (): Promise<string> => {
      let said = msg.text;
      if (msg.audioUrl) {
        const t = await transcribeWithUsage(openai, await downloadVoice(msg.audioUrl), user.industry || undefined);
        cost += costUsd("gpt-4o-transcribe", t.usage) ?? 0;
        said = [said, t.text].filter(Boolean).join("\n");
      }
      return said;
    };

    /** One AI quote turn on session.messages (the user's message is already the last one) and the reply. */
    const quoteTurn = async (session: WaSession, extra: Record<string, string | number | null> = {}) => {
      speak = true;
      const ctx = { company_name: user.companyName || "העסק", industry: user.industry || "כללי", user_id: user.userId };
      const turn = await runTurn(openai, ctx, session.messages, session.quote);
      cost += turn.cost;
      session.messages.push({ role: "assistant", content: turn.text });
      session.quote = turn.quote;
      await saveSession(session);
      const hasQuote = !!session.quote.items?.length;
      if (turn.updated && hasQuote) await reply(contactId, formatSummary(session.quote, turn.text), "summary");
      else await reply(contactId, turn.text);
      return report({ result: "ai_reply", updated: turn.updated, items: session.quote.items?.length ?? 0, turn: session.messages.length, ...turn.flags, ...extra });
    };

    /** A task / meeting draft from all the user's messages so far, and its summary with [לשמור] / [ביטול]. */
    const taskTurn = async (session: WaSession, extra: Record<string, string | number | null> = {}) => {
      speak = true;
      const r = await extractTask(openai, session.messages);
      cost += r.cost;
      session.quote = { task: r.task };
      await saveSession(session);
      await reply(contactId, formatTask(r.task, hasTaskFlow()), "task");
      return report({ result: "task_draft", task_type: r.task.task_type, has_date: !!r.task.date, has_time: !!r.task.time, turn: session.messages.length, ...extra });
    };

    /** An image or PDF outside a quote → Bubble whatsapp_expenses; one answer per burst. */
    const expense = async () => {
      speak = true;
      const r = await addExpense(contactId, msg.fileUrl);
      if (r === "user_not_found") { await reply(contactId, T.expenseNoUser); return report({ result: "expense_no_user", router: "on" }); }
      const marker = crypto.randomUUID().slice(0, 8);
      if (r === "not_eligible") {
        await report({ result: "expense_blocked", batch: marker, router: "on" });
        speak = false;
        if ((await burstCount(contactId, marker, "expense_blocked", "expense_blocked_replied")) == null) return;
        if (await answeredRecently(contactId, "expense_blocked_replied")) return;
        await reply(contactId, T.expenseLimit);
        return report({ result: "expense_blocked_replied", router: "on" });
      }
      await report({ result: "expense_saved", batch: marker, router: "on" });
      speak = false; // saved already: a failure from here must not say "something went wrong"
      // The first file of a burst is answered at once; the rest wait for the burst to end.
      try {
        if (await firstInBurst(contactId, marker, "expense_saved", "expense_replied")) await reply(contactId, T.expenseFirst);
      } catch (err) {
        console.error("[wa/message] first-in-burst check failed:", err instanceof Error ? err.message : err);
      }
      const n = await burstCount(contactId, marker, "expense_saved", "expense_replied");
      if (n == null) return; // a newer file in this burst answers for all
      // One file got its "✅ התקבל" already. Several files: one total. Either way the row closes the burst.
      if (n > 1) await reply(contactId, T.expenseTotal(n));
      return report({ result: "expense_replied", n, router: "on" });
    };

    /** WA_ROUTER_MODE=on: a message outside an open quote. */
    const routeOn = async () => {
      speak = false;
      if (msg.fileUrl) {
        if (fileKind(msg.fileUrl) === "image") {
          const r = await isReceiptImage(openai, msg.fileUrl);
          cost += r.cost;
          if (!r.receipt) { await endConversation(contactId); return report({ result: "routed", route: "support", why: "not_receipt", router: "on" }); }
        }
        return expense();
      }
      const said = await hear();
      if (!said) { await endConversation(contactId); return report({ result: "routed", route: null, why: "no_speech", router: "on" }); }
      const c = await classify(openai, said);
      cost += c.cost;
      const props = { route: c.route, confidence: Math.round(c.confidence * 100) / 100, router: "on" };

      if (c.route === "quote") {
        if (!user.canContinue) return overLimit();
        await startConversation(contactId);
        return quoteTurn({ contact_id: contactId, user_id: user.userId, messages: [{ role: "user", content: said }], quote: {} }, props);
      }
      if (c.route === "expense") {
        speak = true;
        await reply(contactId, T.sendFile);
        await endConversation(contactId);
        return report({ result: "routed", ...props });
      }
      if (c.route === "task") {
        // Same as a quote: the conversation stays open (⏳) until save or cancel.
        await startConversation(contactId);
        return taskTurn({ contact_id: contactId, user_id: user.userId, messages: [{ role: "user", content: said }], quote: {} }, props);
      }
      if (c.route === "unsure" && hasChoiceFlow()) {
        // The message waits in a "pending" session until a button is pressed.
        speak = true;
        await saveSession({ contact_id: contactId, user_id: user.userId, messages: [{ role: "user", content: said }], quote: { pending: true } });
        await reply(contactId, T.choice, "choice");
        await endConversation(contactId);
        return report({ result: "asked", ...props });
      }
      // support, auto_reply, unsure without the CHOICE flow: stays in Live Chat for a person.
      await endConversation(contactId);
      // A support message gets "we got it, a person will answer" + what the bot can do, once per MENU_EVERY.
      // Never to an auto-reply ("תודה שפנית ל...") after our own notifications: two bots must not talk.
      if (c.route === "support") {
        try {
          if (!(await answeredRecently(contactId, "menu", MENU_EVERY_MS))) {
            await reply(contactId, user.canContinue ? T.menu : `${T.menu}\n\n${T.menuUpgrade}`);
            return report({ result: "menu", ...props, ...(user.canContinue ? {} : { why: "over_limit" }) });
          }
        } catch (err) {
          // The message still waits for a person in Live Chat: no error text.
          console.error("[wa/message] menu failed:", err instanceof Error ? err.message : err);
        }
      }
      return report({ result: "routed", ...props });
    };

    if (msg.action === "start") {
      // An empty row marks the conversation as open; without one, messages go back to support (below).
      await saveSession({ contact_id: contactId, user_id: user.userId, messages: [], quote: {} });
      await reply(contactId, T.start);
      return report({ result: "started" });
    }
    if (msg.action === "cancel") {
      const open = await loadSession(contactId, user.userId).catch(() => null);
      await deleteSession(contactId);
      await reply(contactId, open?.quote.task ? T.taskCancelled : T.cancelled);
      await endConversation(contactId);
      return report({ result: "cancelled" });
    }

    let session = await loadSession(contactId, user.userId);

    // The router asked "quote or human?" about this message.
    if (session?.quote.pending) {
      if (msg.action === "human") {
        await deleteSession(contactId);
        await reply(contactId, T.human);
        await endConversation(contactId);
        return report({ result: "to_human" });
      }
      if (msg.action === "assist") {
        if (!user.canContinue) { await deleteSession(contactId); return overLimit(); }
        session.quote = {};
        await startConversation(contactId);
        return await quoteTurn(session, { route: "quote", why: "button" });
      }
      // Anything else: forget the question and route the new message.
      await deleteSession(contactId);
      session = null;
    }

    // No open conversation (a day without activity, or ManyChat still "on" from before):
    // off/shadow — no answer, the message stays in Live Chat for a person. on — the router decides.
    // The save button of an old summary still gets an answer.
    // A button of an old "quote or human?" question (another message came in between): still answer it.
    if (msg.action === "human") {
      await reply(contactId, T.human);
      if (!session) await endConversation(contactId);
      return report({ result: "to_human", why: "stale_button" });
    }
    if (msg.action === "assist" && !session) {
      await reply(contactId, T.assistStale);
      return report({ result: "stale_button" });
    }
    if (!session) {
      if (msg.action === "save") await reply(contactId, T.expired);
      if (mode === "on" && !msg.action) return await routeOn();
      await endConversation(contactId);
      if (mode === "off" || msg.action) return report({ result: "no_session" });
      return shadow("no_session", user);
    }

    // An open task / meeting: save, or a correction that updates the draft. Not limited by the 5 free quotes.
    if (session.quote.task) {
      if (msg.action === "assist" || msg.action === "human") return report({ result: "stale_button" });
      if (msg.fileUrl && !msg.text) {
        await reply(contactId, T.fileInTask);
        return report({ result: "file_in_task" });
      }
      if (msg.action === "save") {
        const task = session.quote.task;
        await createTask(user.userId, task);
        await deleteSession(contactId);
        await reply(contactId, T.taskSaved);
        await endConversation(contactId);
        return report({ result: "task_saved", task_type: task.task_type, has_date: !!task.date, has_time: !!task.time });
      }
      const said = await hear();
      if (!said) { await reply(contactId, T.noSpeech); return report({ result: "no_speech" }); }
      session.messages.push({ role: "user", content: said });
      return await taskTurn(session);
    }

    if (!user.canContinue) return overLimit();
    if (msg.action === "assist" || msg.action === "human") return report({ result: "stale_button" });

    // An image or PDF in the middle of a quote: don't try to transcribe it.
    if (msg.fileUrl && !msg.text && !msg.action) {
      await reply(contactId, T.fileInQuote);
      return report({ result: "file_in_quote" });
    }

    if (msg.action === "save") {
      if (!session.quote.items?.length) { await reply(contactId, T.nothingToSave); return report({ result: "nothing_to_save" }); }
      const saved = await saveQuote(session.quote, user.userId);
      await deleteSession(contactId);
      await reply(contactId, T.saved(saved.url), "saved");
      await endConversation(contactId);
      return report({ result: "saved", mode: session.quote.pricing_mode ?? null, items: session.quote.items.length });
    }

    const said = await hear();
    if (!said) { await reply(contactId, T.noSpeech); return report({ result: "no_speech" }); }
    session.messages.push({ role: "user", content: said });
    return await quoteTurn(session);
  } catch (err) {
    console.error("[wa/message] error:", err instanceof Error ? err.message : err);
    if (speak) await reply(contactId, T.error).catch(() => {});
    return report({ result: "error", router: mode });
  }
}
