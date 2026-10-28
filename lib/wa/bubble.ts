import { buildPerItemPayload, buildTotalPayload, toBubbleTest } from "@/lib/v2/quote";
import type { QuoteV2 } from "@/lib/v2/quote";

/**
 * Bubble calls for the WhatsApp quote chat.
 * WA_BUBBLE_ENV=test sends everything to version-test (used while testing on Amit's number).
 */

const isTest = () => /test/i.test(process.env.WA_BUBBLE_ENV ?? "");
const env = (url: string) => (isTest() ? toBubbleTest(url) : url);

async function post(url: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const key = process.env.BUBBLE_API_KEY;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, text: await res.text().catch(() => "") };
}

export interface WaUser {
  userId: string;
  companyName: string;
  industry: string;
  canContinue: boolean;
}

/**
 * wa_quote_user (Admin only): the Bubble user whose Manychat_id is this contact.
 * null = no Tiktok user for this WhatsApp contact.
 */
export async function lookupUser(contactId: string): Promise<WaUser | null> {
  const base = process.env.BUBBLE_WEBHOOK_URL;
  const url = process.env.BUBBLE_WA_USER_URL || base?.replace(/update_quote\/?$/, "wa_quote_user");
  if (!url) throw new Error("BUBBLE_WA_USER_URL not configured");
  const { status, text } = await post(env(url), { id: contactId });
  if (status !== 200) throw new Error(`wa_quote_user HTTP ${status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  const r = (j.response ?? j) as Record<string, unknown>;
  const userId = typeof r.user_id === "string" ? r.user_id.trim() : "";
  if (!userId) return null;
  return {
    userId,
    companyName: typeof r.company_name === "string" ? r.company_name : "",
    industry: typeof r.industry === "string" ? r.industry : "",
    canContinue: r.can_continue === true || r.can_continue === "yes",
  };
}

/** Same workflows and payloads as /api/v2/approve-quote. Returns the quote page URL. */
export async function saveQuote(quote: Partial<QuoteV2>, userId: string): Promise<{ quoteId: string; url?: string }> {
  const base = process.env.BUBBLE_WEBHOOK_URL;
  if (!base) throw new Error("BUBBLE_WEBHOOK_URL not configured");
  const perItem = quote.pricing_mode === "per_item";
  const url = perItem ? process.env.BUBBLE_PER_ITEM_URL || base.replace(/update_quote\/?$/, "update_quote_per_item") : base;
  const payload = perItem ? buildPerItemPayload(quote, userId, "whatsapp") : buildTotalPayload(quote, userId);
  const { status, text } = await post(env(url), payload);
  if (status !== 200) throw new Error(`save HTTP ${status}: ${text.slice(0, 200)}`);
  let quoteId: string | undefined;
  try {
    const j = JSON.parse(text);
    quoteId = j.quote_id ?? j.response?.quote_id;
  } catch { /* ignore */ }
  if (!quoteId) throw new Error("save: no quote_id");
  const redirectBase = process.env.NEXT_PUBLIC_REDIRECT_BASE ?? "";
  return { quoteId, url: redirectBase ? env(redirectBase) + quoteId : undefined };
}
