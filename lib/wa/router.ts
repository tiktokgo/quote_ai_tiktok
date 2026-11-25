import OpenAI from "openai";
import { costUsd } from "@/lib/v2/track";

/**
 * The WhatsApp router (tiktok-hq/docs/plans/wa-assistant-plan.html, phase 1):
 * a message outside an open quote goes to a quote, an expense, a task, or human support.
 *
 * WA_ROUTER_MODE
 *   off    (default) — exactly the old behavior.
 *   shadow — messages outside a quote are classified and logged to v2_events (event wa_message,
 *            props route/confidence), but nobody gets an answer: they stay in Live Chat as today.
 *   on     — acting on the route: expenses to Bubble, quote from a free message, buttons when unsure.
 *
 * WA_ROUTER_ON_CONTACTS — comma-separated ManyChat contact ids that get "on" while everyone else
 *   is in shadow (testing on Amit's own number). Ignored when the mode is off.
 */

export type RouterMode = "off" | "shadow" | "on";
export type Route = "quote" | "expense" | "task" | "support" | "auto_reply" | "unsure";

export function routerMode(contactId?: string): RouterMode {
  const m = (process.env.WA_ROUTER_MODE ?? "").trim().toLowerCase();
  const mode: RouterMode = m === "shadow" || m === "on" ? m : "off";
  if (mode !== "shadow" || !contactId) return mode;
  const testers = (process.env.WA_ROUTER_ON_CONTACTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return testers.includes(contactId) ? "on" : "shadow";
}

const MODEL = "gpt-4o-mini";
/** Below this the router asks the user instead of guessing. */
const MIN_CONFIDENCE = 0.7;

const SYSTEM = `You route WhatsApp messages that business owners send to Tiktok (תיקתוק), an Israeli app for price quotes, invoices, receipts and expenses.
Classify the user's message (usually Hebrew, sometimes a voice transcript) into one route:
- quote: wants to create or prepare a price quote (הצעת מחיר) for a client, or describes a job for a client with work items or prices.
- expense: wants to record an expense, a receipt or a supplier invoice they paid (הוצאה, קבלה, חשבונית מספק).
- task: asks for a reminder, a task, a follow-up or a meeting / calendar entry (תזכיר לי, משימה, פגישה).
- auto_reply: an automatic message of the other side's WhatsApp Business, not written by a person now: "תודה שפנית ל...", "נחזור אליך בהקדם", away / out of office / business hours, an auto greeting of a business.
- support: a question or problem about the app, the account, payment or subscription, a greeting, thanks, or anything else.
- unsure: it could be more than one of the above and you can't tell.
Answer only JSON: {"route": "quote|expense|task|support|auto_reply|unsure", "confidence": 0-1}`;

const ROUTES: Route[] = ["quote", "expense", "task", "support", "auto_reply", "unsure"];

export async function classify(openai: OpenAI, text: string): Promise<{ route: Route; confidence: number; cost: number }> {
  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 30,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: text.slice(0, 1500) },
    ],
  });
  const cost = costUsd(MODEL, res.usage) ?? 0;
  let route: Route = "unsure";
  let confidence = 0;
  try {
    const j = JSON.parse(res.choices[0]?.message?.content ?? "{}") as { route?: unknown; confidence?: unknown };
    if (typeof j.route === "string" && (ROUTES as string[]).includes(j.route)) route = j.route as Route;
    if (typeof j.confidence === "number" && Number.isFinite(j.confidence)) confidence = Math.max(0, Math.min(1, j.confidence));
  } catch { /* stays unsure */ }
  if (confidence < MIN_CONFIDENCE) route = "unsure";
  return { route, confidence, cost };
}

/**
 * A photo sent outside a quote is an expense only if it looks like one: users also send
 * screenshots of a problem to support. PDFs are not checked. Low detail = ~85 image tokens.
 */
export async function isReceiptImage(openai: OpenAI, url: string): Promise<{ receipt: boolean; cost: number }> {
  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 15,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: 'Is this image a receipt, an invoice, a bill or another document of a payment or expense (any language, photo or scan)? A screenshot of an app, a chat or an error is NOT. Answer only JSON: {"receipt": true|false}' },
      { role: "user", content: [{ type: "image_url", image_url: { url, detail: "low" } }] },
    ],
  });
  const cost = costUsd(MODEL, res.usage) ?? 0;
  try {
    const j = JSON.parse(res.choices[0]?.message?.content ?? "{}") as { receipt?: unknown };
    return { receipt: j.receipt === true, cost };
  } catch {
    return { receipt: false, cost };
  }
}
