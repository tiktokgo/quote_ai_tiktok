import { NextRequest } from "next/server";
import OpenAI from "openai";
import { verifyToken } from "@/lib/verifyToken";
import { buildSystemPromptV2 } from "@/lib/v2/systemPrompt";
import { guardUpdate } from "@/lib/v2/guard";
import { UNITS, mergeQuoteV2, computeTotals } from "@/lib/v2/quote";
import type { QuoteV2, QuoteUpdateV2 } from "@/lib/v2/quote";

export const maxDuration = 60;

const MAX_MESSAGES = 60;
const MAX_CHARS = 50000;

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
        has_tax: { type: "boolean", description: "per_item: add 18% VAT on top. total: the price includes VAT." },
        discount_amount: { type: "number", description: "per_item only, in ILS" },
        discount_percent: { type: "number", description: "per_item only, when the user said a percentage" },
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

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

/** What to ask next when the model updated the quote but wrote no text. */
function nextQuestion(q: Partial<QuoteV2>): string {
  if (!q.client?.name && !q.client?.address) return "למי ההצעה ולאיזו כתובת?";
  if (!q.client?.name) return "מה שם הלקוח?";
  if (!q.client?.address) return "ומה הכתובת?";
  if (q.pricing_mode !== "per_item" && !q.total) return "מה המחיר? אפשר סכום אחד לכל העבודה, או מחיר לכל פריט.";
  if (q.has_tax === undefined) return q.pricing_mode === "per_item" ? "האם להוסיף מע״מ?" : "המחיר כולל מע״מ?";
  return "הצעת המחיר מוכנה — עיין בה, ואפשר לשנות כל דבר בקול או בטקסט.";
}

const brief = (text: string) => text.trim().slice(0, 400);


const FALSE_UPDATE = /(עדכנתי|הוספתי|שמרתי|נרשם|הכנתי|יצרתי|שיניתי|הסרתי|מחקתי)/;

export async function POST(req: NextRequest) {
  let body: { messages?: { role: string; content: string }[]; currentQuote?: Partial<QuoteV2>; token?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // v2 is for logged-in users only — the context comes from the JWT, never from the client.
  const v = verifyToken(body.token ?? "");
  if (!v.valid) return json({ error: "Invalid token" }, 401);
  const ctx = v.payload;

  if (!Array.isArray(body.messages)) return json({ error: "Missing messages" }, 400);
  const history = body.messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, MAX_CHARS) }));

  const current: Partial<QuoteV2> = body.currentQuote && typeof body.currentQuote === "object" ? body.currentQuote : {};

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPromptV2(ctx) },
  ];
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

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: [UPDATE_QUOTE_TOOL],
      tool_choice: "auto",
      parallel_tool_calls: false,
      temperature: 0.3,
    });
    const msg = res.choices[0]?.message;
    let text = msg?.content ?? "";
    let update: QuoteUpdateV2 | null = null;

    const call = msg?.tool_calls?.find((c) => c.type === "function" && c.function.name === "update_quote");
    if (call && call.type === "function") {
      try {
        update = JSON.parse(call.function.arguments) as QuoteUpdateV2;
      } catch {
        console.warn("[v2/chat] malformed tool args:", call.function.arguments.slice(0, 200));
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
      const fc = forced.choices[0]?.message?.tool_calls?.[0];
      if (fc && fc.type === "function") {
        try {
          update = JSON.parse(fc.function.arguments) as QuoteUpdateV2;
          console.log("[v2/chat] forced update");
        } catch { /* ignore */ }
      }
    }

    if (update) {
      const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
      update = guardUpdate(current, update, lastUser);
      const merged = mergeQuoteV2(current, update);
      console.log(`[v2/chat] mode:${merged.pricing_mode} items:${merged.items?.length ?? 0}`);
      if (!text.trim()) text = nextQuestion(merged);
    }
    if (!text.trim()) text = "לא הבנתי — אפשר לנסח שוב?";

    return json({ text: brief(text), quote: update });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("[v2/chat] error:", m);
    return json({ error: "ai_error" }, 502);
  }
}
