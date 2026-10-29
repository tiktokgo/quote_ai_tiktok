/**
 * Replies to WhatsApp go through the ManyChat API, not the External Request response:
 * ManyChat waits ~10s for a response and an AI turn (+ transcription) can take longer.
 * The text goes into the custom field `wa_quote_reply`, then a ManyChat flow shows it:
 *   MANYCHAT_FLOW_SUMMARY — {{wa_quote_reply}} + buttons "לשמור" / "לשנות"
 *   MANYCHAT_FLOW_SAVED   — {{wa_quote_reply}} + button "הצעה חדשה" (→ the "התחלה" automation)
 *   MANYCHAT_FLOW_TEXT    — {{wa_quote_reply}} only
 * Buttons and wording live in ManyChat, so they can change without a deploy.
 */

const API = "https://api.manychat.com/fb";
const REPLY_FIELD = "wa_quote_reply";
const MODE_FIELD = "wa_quote_mode";
const MAX_TEXT = 3500; // WhatsApp allows 4096

async function call(path: string, body: Record<string, unknown>): Promise<void> {
  const key = process.env.MANYCHAT_API_KEY;
  if (!key) throw new Error("MANYCHAT_API_KEY not configured");
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text().catch(() => "");
  // ManyChat answers 200 with {"status":"error"} for some failures.
  if (!res.ok || /"status"\s*:\s*"error"/.test(text)) {
    throw new Error(`manychat ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** The contact's last message (text, or the voice-note URL) — ManyChat system field last_input_text. */
export async function lastInput(contactId: string): Promise<string> {
  const key = process.env.MANYCHAT_API_KEY;
  if (!key) throw new Error("MANYCHAT_API_KEY not configured");
  const res = await fetch(`${API}/subscriber/getInfo?subscriber_id=${encodeURIComponent(contactId)}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`manychat getInfo HTTP ${res.status}: ${text.slice(0, 200)}`);
  const v = (JSON.parse(text) as { data?: { last_input_text?: unknown } }).data?.last_input_text;
  return typeof v === "string" ? v : "";
}

export type ReplyKind ="summary" | "saved" | "text";

/** "saved" has its own flow (button "הצעה חדשה") once MANYCHAT_FLOW_SAVED is set; until then, plain text. */
export const hasSavedFlow = () => !!process.env.MANYCHAT_FLOW_SAVED;

export async function reply(contactId: string, text: string, kind: ReplyKind = "text"): Promise<void> {
  if (kind === "saved" && !hasSavedFlow()) kind = "text";
  const flow = { summary: process.env.MANYCHAT_FLOW_SUMMARY, saved: process.env.MANYCHAT_FLOW_SAVED, text: process.env.MANYCHAT_FLOW_TEXT }[kind];
  if (!flow) throw new Error(`MANYCHAT_FLOW_${kind.toUpperCase()} not configured`);
  const subscriber_id = Number(contactId);
  await call("/subscriber/setCustomFieldByName", {
    subscriber_id,
    field_name: REPLY_FIELD,
    field_value: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
  });
  await call("/sending/sendFlow", { subscriber_id, flow_ns: flow });
}

/**
 * ManyChat sends every message to /api/wa/message while `wa_quote_mode` is "on" (set by "התחלה").
 * Turning it off hands the chat back to human support. Never throws: a failure here must not
 * replace a reply the user already got with the error text.
 */
export async function endConversation(contactId: string): Promise<void> {
  try {
    await call("/subscriber/setCustomFieldByName", { subscriber_id: Number(contactId), field_name: MODE_FIELD, field_value: "off" });
  } catch (err) {
    console.error("[wa/manychat] mode off failed:", err instanceof Error ? err.message : err);
  }
}
