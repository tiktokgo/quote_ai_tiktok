/**
 * Replies to WhatsApp go through the ManyChat API, not the External Request response:
 * ManyChat waits ~10s for a response and an AI turn (+ transcription) can take longer.
 * The text goes into the custom field `wa_quote_reply`, then a ManyChat flow shows it:
 *   MANYCHAT_FLOW_SUMMARY — {{wa_quote_reply}} + buttons "לשמור" / "לשנות"
 *   MANYCHAT_FLOW_TEXT    — {{wa_quote_reply}} only
 * Buttons and wording live in ManyChat, so they can change without a deploy.
 */

const API = "https://api.manychat.com/fb";
const REPLY_FIELD = "wa_quote_reply";
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

export type ReplyKind = "summary" | "text";

export async function reply(contactId: string, text: string, kind: ReplyKind = "text"): Promise<void> {
  const flow = kind === "summary" ? process.env.MANYCHAT_FLOW_SUMMARY : process.env.MANYCHAT_FLOW_TEXT;
  if (!flow) throw new Error(`MANYCHAT_FLOW_${kind.toUpperCase()} not configured`);
  const subscriber_id = Number(contactId);
  await call("/subscriber/setCustomFieldByName", {
    subscriber_id,
    field_name: REPLY_FIELD,
    field_value: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
  });
  await call("/sending/sendFlow", { subscriber_id, flow_ns: flow });
}
