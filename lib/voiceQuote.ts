import OpenAI from "openai";

/**
 * Voice → quote: transcribe a recording, extract a quote, and normalize it into
 * one of two shapes — "total" (one price for everything) or "per_item".
 * Decisions (tiktok-hq/docs/decisions.md, 2026-10-15):
 * - the quote is always a draft in Bubble
 * - per_item: a price that was not said is sent as 0 and listed in missing_prices
 * - the AI never computes totals or VAT — Bubble does
 */

export const UNITS = ["כמות", "יח'", 'מ"ר', "שעות"] as const;

export interface VoiceClient {
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  is_business: boolean;
  business_name: string | null;
}

export interface VoiceItem {
  description: string;
  details: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
}

interface BaseQuote {
  title: string | null;
  client: VoiceClient;
  price_includes_vat: boolean;
  discount_percent: number | null;
  discount_amount: number | null;
  notes: string | null;
}

export interface TotalQuote extends BaseQuote {
  pricing_mode: "total";
  total: number;
  total_missing: boolean;
  included_items: { description: string; details: string | null }[];
}

export interface PerItemQuote extends BaseQuote {
  pricing_mode: "per_item";
  items: VoiceItem[];
  missing_prices: string[];
}

export type VoiceQuote = TotalQuote | PerItemQuote;

const nullable = (type: string) => ({ type: [type, "null"] });

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "is_quote", "pricing_mode", "title", "client", "total", "included_items",
    "items", "price_includes_vat", "discount_percent", "discount_amount", "notes",
  ],
  properties: {
    is_quote: { type: "boolean" },
    pricing_mode: { type: "string", enum: ["total", "per_item"] },
    title: nullable("string"),
    client: {
      type: "object",
      additionalProperties: false,
      required: ["name", "phone", "email", "address", "is_business", "business_name"],
      properties: {
        name: nullable("string"),
        phone: nullable("string"),
        email: nullable("string"),
        address: nullable("string"),
        is_business: { type: "boolean" },
        business_name: nullable("string"),
      },
    },
    total: nullable("number"),
    included_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "details"],
        properties: { description: { type: "string" }, details: nullable("string") },
      },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "details", "quantity", "unit", "unit_price", "free"],
        properties: {
          description: { type: "string" },
          details: nullable("string"),
          quantity: nullable("number"),
          unit: { type: "string", enum: [...UNITS] },
          unit_price: nullable("number"),
          free: { type: "boolean" },
        },
      },
    },
    price_includes_vat: { type: "boolean" },
    discount_percent: nullable("number"),
    discount_amount: nullable("number"),
    notes: nullable("string"),
  },
} as const;

type Extracted = {
  is_quote: boolean;
  pricing_mode: "total" | "per_item";
  title: string | null;
  client: VoiceClient;
  total: number | null;
  included_items: { description: string; details: string | null }[];
  items: {
    description: string;
    details: string | null;
    quantity: number | null;
    unit: string;
    unit_price: number | null;
    free: boolean;
  }[];
  price_includes_vat: boolean;
  discount_percent: number | null;
  discount_amount: number | null;
  notes: string | null;
};

const SYSTEM = (industry?: string) => `אתה מקבל תמלול של הודעה קולית שבעל מקצוע${industry ? ` (תחום: ${industry})` : ""} הקליט כדי להכין הצעת מחיר ללקוח. התמלול אוטומטי ועלול להכיל שגיאות — תקן מילים שגויות לפי ההקשר המקצועי.

## שלב 1 — האם זו הצעת מחיר
אם התמלול לא מתאר עבודה/שירות (שקט, ג'יבריש, שיחה לא קשורה) — is_quote=false והשאר את השאר ריק.

## שלב 2 — סוג ההצעה (pricing_mode)
- "total": נאמר **סכום אחד** לכל העבודה, ושום פריט לא קיבל מחיר משלו. שים את הסכום ב-total, ואת כל מה שכלול בו ב-included_items (בלי מחירים). items ריק.
- "per_item": נאמרו מחירים לפריטים נפרדים, **או** לא נאמר שום מחיר. כל עבודה = פריט ב-items. total=null, included_items ריק.
- מעורב ("העבודה 8000 כולל הכל, ובנוסף פינוי 500") → "per_item": פריט ראשי 8000 (מה שכלול בו נכנס ל-details שלו) + פינוי 500.

## פריטים (per_item)
- unit_price: המחיר ליחידה כפי שנאמר. אם לא נאמר מחיר לפריט — null. **אל תמציא ואל תעריך מחירים.**
- free=true רק אם נאמר במפורש שהפריט בחינם / כלול / "על חשבוני". אז unit_price=0.
- quantity: כמות שנאמרה, אחרת null. unit: אחת מ: ${UNITS.join(", ")}.
- אם נאמר "X ליחידה" וכמות — unit_price הוא המחיר ליחידה. אם נאמר סכום לכל הכמות — חלק בכמות.
- description קצר וברור; details — שורה מקצועית על מה כלול, או null.

## לקוח
name, phone (ספרות בלבד, כפי שנאמר), email, address — רק אם נאמרו. is_business=true אם הלקוח עסק/חברה, ואז business_name.

## מע"מ והנחה
- price_includes_vat=true רק אם נאמר במפורש "כולל מע"מ". "כולל חומרים/הובלה/התקנה" אינו מע"מ.
- הנחה באחוזים → discount_percent; הנחה בשקלים → discount_amount. אחרת null.
- אל תחשב סכומים, מע"מ או סה"כ.

## כותרת והערות
- title: כותרת קצרה להצעה, למשל "התקנת מזגן — הרצל 10 חולון".
- notes: רק מה שנאמר — תנאי תשלום, מקדמה, אחריות, זמני ביצוע, תוקף. שורה לכל הערה. אסור להמציא. אם לא נאמר כלום — null.

כתוב הכל בעברית.`;

export async function transcribe(openai: OpenAI, audio: File, industry?: string): Promise<string> {
  const res = await openai.audio.transcriptions.create({
    file: audio,
    model: "gpt-4o-transcribe",
    language: "he",
    prompt: `הקלטה של בעל מקצוע${industry ? ` בתחום ${industry}` : ""} שמכתיב הצעת מחיר: שם לקוח, טלפון, כתובת, עבודות, כמויות ומחירים בשקלים.`,
  });
  return res.text.trim();
}

export async function extractQuote(
  openai: OpenAI,
  transcript: string,
  industry?: string,
): Promise<VoiceQuote | null> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM(industry) },
      { role: "user", content: transcript },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "voice_quote", strict: true, schema: EXTRACT_SCHEMA as unknown as Record<string, unknown> },
    },
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  return normalize(JSON.parse(raw) as Extracted, transcript);
}

const blankToNull = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/** Deterministic cleanup on top of the model output. */
export function normalize(x: Extracted, transcript: string): VoiceQuote | null {
  if (!x.is_quote) return null;

  // The model over-triggers "includes VAT"; if VAT was never mentioned it must be false.
  const vatMentioned = /מע["״'׳]?מ|מעמ/.test(transcript);
  const base: BaseQuote = {
    title: blankToNull(x.title),
    client: {
      name: blankToNull(x.client.name),
      phone: x.client.phone ? x.client.phone.replace(/\D/g, "") || null : null,
      email: blankToNull(x.client.email),
      address: blankToNull(x.client.address),
      is_business: x.client.is_business,
      business_name: x.client.is_business ? blankToNull(x.client.business_name) : null,
    },
    price_includes_vat: vatMentioned && x.price_includes_vat,
    discount_percent: x.discount_percent || null,
    discount_amount: x.discount_amount || null,
    notes: blankToNull(x.notes),
  };

  const items = x.items.filter((i) => i.description?.trim());

  if (x.pricing_mode === "total" && items.every((i) => i.unit_price == null)) {
    const included = [
      ...x.included_items,
      ...items.map((i) => ({ description: i.description, details: i.details })),
    ].filter((i) => i.description?.trim());
    return {
      ...base,
      pricing_mode: "total",
      total: x.total ?? 0,
      total_missing: x.total == null,
      included_items: included.map((i) => ({ description: i.description.trim(), details: blankToNull(i.details) })),
    };
  }

  // per_item (also the fallback when the model said "total" but priced individual items)
  if (items.length === 0 && x.included_items.length > 0) {
    items.push(...x.included_items.map((i) => ({ ...i, quantity: 1, unit: "יח'", unit_price: null, free: false })));
    if (x.total != null) items[0].unit_price = x.total;
  }
  else if (x.total != null) {
    // A total was said next to priced items — don't drop it silently; surface it for review.
    const line = `סכום כולל שנאמר בהקלטה: ${x.total} ₪`;
    base.notes = base.notes ? `${base.notes}\n${line}` : line;
  }
  const missing: string[] = [];
  return {
    ...base,
    pricing_mode: "per_item",
    items: items.map((i) => {
      const unit_price = i.free ? 0 : i.unit_price;
      if (unit_price == null) missing.push(i.description.trim());
      return {
        description: i.description.trim(),
        details: blankToNull(i.details),
        quantity: i.quantity && i.quantity > 0 ? i.quantity : 1,
        unit: (UNITS as readonly string[]).includes(i.unit) ? i.unit : "יח'",
        unit_price: unit_price ?? 0,
      };
    }),
    missing_prices: missing,
  };
}
