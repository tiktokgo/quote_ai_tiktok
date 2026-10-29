import OpenAI from "openai";
import { buildSystemPromptV2 } from "@/lib/v2/systemPrompt";
import { guardUpdate } from "@/lib/v2/guard";
import { UNITS, mergeQuoteV2, computeTotals } from "@/lib/v2/quote";
import { costUsd } from "@/lib/v2/track";
import type { AIContext } from "@/lib/verifyToken";
import type { QuoteV2, QuoteUpdateV2 } from "@/lib/v2/quote";

/**
 * One AI turn for the WhatsApp quote chat. Same model, prompt, guard and merge as
 * /api/v2/chat — copied here on purpose so the live /v2 popup is not touched
 * (tiktok-hq/docs/whatsapp-quote.md). Merge the two once WhatsApp is stable.
 * Differences: a channel note, and suggested_items are shown as a numbered list in the summary
 * (no chips) — the user answers with numbers ("תוסיף 1 ו-3").
 */

const UPDATE_QUOTE_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "update_quote",
    description:
      "Update the quote shown to the user. Send only fields that changed — except items: when items change, send the FULL list. Never compute totals.",
    parameters: {
      type: "object",
      properties: {
        pricing_mode: { type: "string", enum: ["total", "per_item"] },
        title: { type: "string" },
        industry: { type: "string" },
        client: {
          type: "object",
          properties: {
            name: { type: "string" },
            address: { type: "string" },
            phone: { type: "string" },
            email: { type: "string" },
          },
        },
        items: {
          type: "array",
          description: "The full list of line items, in order.",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string", description: "Short item name in Hebrew, no prices" },
              description: { type: "string", description: "Details in Hebrew, may be empty, no prices" },
              quantity: { type: "number", description: "Default 1" },
              unit: { type: "string", enum: [...UNITS] },
              unit_price: { type: "number", description: "Price for ONE unit in ILS, 0 if not said or free" },
            },
          },
        },
        total: { type: "number", description: "total mode only: the one price the user said, in ILS" },
        has_tax: { type: "boolean", description: "Add 18% VAT on top of the prices (both modes)." },
        price_includes_vat: { type: "boolean", description: "true when the user said the prices in THIS message already INCLUDE VAT ('כולל מע\"מ'). Send the prices exactly as said — the system converts them. Never compute it yourself." },
        discount_amount: { type: "number", description: "Discount in ILS (both modes). Never change pricing_mode because of a discount." },
        discount_percent: { type: "number", description: "When the user said a percentage (both modes)" },
        warranty: { type: "string" },
        terms: { type: "string" },
        comments: { type: "string" },
        suggested_items: {
          type: "array",
          description: "4-6 related items the user did NOT mention, offered as optional additions. Never also put them in items.",
          items: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" }, description: { type: "string" } },
          },
        },
      },
    },
  },
};

const WHATSAPP_NOTE =
  `## ערוץ: וואטסאפ\n` +
  `המשתמש כותב או מקליט לך מוואטסאפ, בלי מסך. אחרי כל update_quote המערכת שולחת לו סיכום של ההצעה עם כפתורים "לשמור" ו"לשנות".\n` +
  `לכן: אל תכתוב את ההצעה, הפריטים או ה-suggested_items בטקסט (הסיכום מציג את ה-suggested_items כרשימה ממוספרת). 1-2 משפטים קצרים בלבד.\n` +
  `כשאין מה לשאול: "אפשר לשמור, או לכתוב / להקליט מה לשנות."`;

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type Suggestion = { name: string; description?: string };
/** The quote kept in wa_sessions: the draft, plus the items last offered in the summary. */
export type WaQuote = Partial<QuoteV2> & { suggested_items?: Suggestion[] };

const MAX_SUGGESTIONS = 6;

/** What to ask next when the model updated the quote but wrote no text. */
function nextQuestion(q: Partial<QuoteV2>): string {
  if (!q.client?.name && !q.client?.address) return "למי ההצעה ולאיזו כתובת?";
  if (!q.client?.name) return "מה שם הלקוח?";
  if (!q.client?.address) return "ומה הכתובת?";
  if (q.pricing_mode !== "per_item" && !q.total) return "מה המחיר? אפשר סכום אחד לכל העבודה, או מחיר לכל פריט.";
  if (q.has_tax === undefined) return "האם להוסיף מע״מ?";
  return "אפשר לשמור, או לכתוב / להקליט מה לשנות.";
}

const FALSE_UPDATE = /(עדכנתי|הוספתי|שמרתי|נרשם|הכנתי|יצרתי|שיניתי|הסרתי|מחקתי)/;

export interface TurnResult {
  text: string;
  quote: WaQuote;
  updated: boolean;
  cost: number;
  flags: { forced: boolean; refilled: boolean };
}

export async function runTurn(openai: OpenAI, ctx: AIContext, history: ChatMessage[], draft: WaQuote): Promise<TurnResult> {
  const { suggested_items: offered = [], ...current } = draft;
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPromptV2(ctx) },
    { role: "system", content: WHATSAPP_NOTE },
  ];
  if (offered.length) {
    messages.push({
      role: "system",
      content:
        `## פריטים שהוצעו למשתמש בסיכום האחרון (ממוספרים)\n` +
        offered.map((s, i) => `${i + 1}. ${s.name}${s.description ? ` — ${s.description}` : ""}`).join("\n") +
        `\nכשהמשתמש עונה במספרים ("תוסיף 1 ו-3", "כן 2,4", "את כולם") — הוסף בדיוק את הפריטים האלה ל-items ` +
        `(רשימה מלאה, כולל הקיימים), עם ה-name וה-description שלהם. במצב per_item: unit_price=0 אם לא נאמר מחיר.`,
    });
  }
  if (Object.keys(current).length > 0) {
    const t = computeTotals(current);
    messages.push({
      role: "system",
      content:
        `## ההצעה כבר קיימת — המשתמש ערך אותה, ואסור לאבד את מה שבה\n` +
        `שנה רק את מה שהמשתמש ביקש בהודעה האחרונה. זו לא טיוטה ראשונה — אל תיצור הצעה מחדש.\n` +
        `הודעה שהיא רק שם / טלפון / כתובת / מייל → עדכן רק את client, בלי items, warranty, terms, comments או title.\n` +
        `שלח items רק אם ביקש לשנות פריטים (ואז רשימה מלאה, כולל כל הפריטים הקיימים כמו שהם).\n` +
        `מצב ההצעה הנוכחי:\n${JSON.stringify(current)}\n` +
        (current.pricing_mode === "per_item" ? `פריטים בלי מחיר: ${t.missingPrices}.` : ""),
    });
  }
  messages.push(...history);

  let cost = 0;
  const flags = { forced: false, refilled: false };

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    tools: [UPDATE_QUOTE_TOOL],
    tool_choice: "auto",
    parallel_tool_calls: false,
    temperature: 0.3,
  });
  cost += costUsd("gpt-4o", res.usage) ?? 0;
  const msg = res.choices[0]?.message;
  let text = msg?.content ?? "";
  let update: QuoteUpdateV2 | null = null;

  const call = msg?.tool_calls?.find((c) => c.type === "function" && c.function.name === "update_quote");
  if (call && call.type === "function") {
    try {
      update = JSON.parse(call.function.arguments) as QuoteUpdateV2;
    } catch {
      console.warn("[wa/ai] malformed tool args:", call.function.arguments.slice(0, 200));
    }
  } else if (FALSE_UPDATE.test(text)) {
    // The model said it changed the quote but did not call the tool — force the call.
    const forced = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [...messages, { role: "assistant", content: text }],
      tools: [UPDATE_QUOTE_TOOL],
      tool_choice: { type: "function", function: { name: "update_quote" } },
      temperature: 0,
    });
    cost += costUsd("gpt-4o", forced.usage) ?? 0;
    const fc = forced.choices[0]?.message?.tool_calls?.[0];
    if (fc && fc.type === "function") {
      try {
        update = JSON.parse(fc.function.arguments) as QuoteUpdateV2;
        flags.forced = true;
      } catch { /* ignore */ }
    }
  }

  let merged: Partial<QuoteV2> = current;
  let suggestions = offered;
  if (update) {
    if (Array.isArray(update.suggested_items) && update.suggested_items.length) suggestions = update.suggested_items;
    delete update.suggested_items;
    const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
    update = guardUpdate(current, update, lastUser);
    merged = mergeQuoteV2(current, update);
    // A quote with an amount but no items — ask once more, for items only.
    if (!merged.items?.length && ((merged.total ?? 0) > 0 || merged.title)) {
      try {
        const again = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            ...messages,
            { role: "system", content: `בטיוטה ששלחת אין פריטים: ${JSON.stringify(update)}\nשלח עכשיו update_quote עם items בלבד: 3-6 פריטים מקצועיים שמפרטים מה העבודה כוללת${merged.pricing_mode === "total" ? " (במצב total — unit_price=0)" : ""}.` },
          ],
          tools: [UPDATE_QUOTE_TOOL],
          tool_choice: { type: "function", function: { name: "update_quote" } },
          temperature: 0.2,
        });
        cost += costUsd("gpt-4o", again.usage) ?? 0;
        const fc = again.choices[0]?.message?.tool_calls?.[0];
        if (fc && fc.type === "function") {
          const items = (JSON.parse(fc.function.arguments) as QuoteUpdateV2).items;
          if (Array.isArray(items) && items.length) {
            update = { ...update, items };
            merged = mergeQuoteV2(current, update);
            flags.refilled = true;
          }
        }
      } catch { /* keep the draft without items */ }
    }
    if (!text.trim()) text = nextQuestion(merged);
  }
  if (!text.trim()) text = "לא הבנתי — אפשר לנסח שוב?";

  // Offer only what is not in the quote yet; numbering follows this list, which is what the summary shows.
  const inQuote = new Set((merged.items ?? []).map((it) => it.name.trim()));
  suggestions = suggestions.filter((s) => s?.name && !inQuote.has(s.name.trim())).slice(0, MAX_SUGGESTIONS);
  const quote: WaQuote = suggestions.length ? { ...merged, suggested_items: suggestions } : merged;

  return { text: text.trim().slice(0, 400), quote, updated: !!update, cost, flags };
}
