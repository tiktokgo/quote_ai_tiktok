import { NextRequest } from "next/server";
import OpenAI from "openai";
import { verifyToken } from "@/lib/verifyToken";
import type { QuoteV2 } from "@/lib/v2/quote";

export const maxDuration = 30;

/**
 * POST /api/v2/suggest — Auth: Authorization: Bearer <JWT>.
 * Body: { kind: "item", quote, index } → { options: [{ name, description }] }  (3 rewordings of one item)
 *       { kind: "notes" | "terms", quote } → { options: [{ text }] }            (3-4 lines to pick from)
 * Nothing is applied here — the page shows the options and the user picks.
 */

type Kind = "item" | "notes" | "terms";

const ITEM_SCHEMA = {
  type: "object", additionalProperties: false, required: ["options"],
  properties: {
    options: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["name", "description"],
        properties: { name: { type: "string" }, description: { type: "string" } },
      },
    },
  },
};

const LINES_SCHEMA = {
  type: "object", additionalProperties: false, required: ["options"],
  properties: {
    options: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
    },
  },
};

function prompt(kind: Kind, q: Partial<QuoteV2>, index: number, industry: string, company: string): string {
  const items = (q.items ?? []).map((it, i) => `${i + 1}. ${it.name}${it.description ? ` — ${it.description}` : ""}`).join("\n");
  const ctx = `עסק: ${company} (תחום: ${industry}).\nכותרת: ${q.title ?? ""}\nפריטים:\n${items || "(אין)"}`;
  if (kind === "item") {
    const it = q.items?.[index];
    return `${ctx}\n\nכתוב 3 ניסוחים שונים לפריט מספר ${index + 1} ("${it?.name ?? ""}"${it?.description ? ` — ${it.description}` : ""}) בהצעת מחיר בעברית.
לכל ניסוח: name קצר ומקצועי (עד 6 מילים) ו-description של שורה אחת שמסבירה ללקוח מה כלול.
הניסוחים צריכים להיות שונים זה מזה: אחד תמציתי, אחד מפורט יותר, אחד שמדגיש את התועלת ללקוח.
אל תשנה את מהות העבודה, אל תוסיף התחייבויות, ואל תכתוב מחירים, כמויות או זמנים שלא נאמרו.`;
  }
  if (kind === "terms") {
    return `${ctx}\nתנאים קיימים: ${[q.warranty, q.terms].filter(Boolean).join(" / ") || "(אין)"}\n\nהצע 4 שורות קצרות של תנאים ואחריות שמקובלות בתחום הזה בישראל:
תנאי תשלום (מקדמה/שוטף), תוקף ההצעה, אחריות, ומה לא כלול. כל שורה עומדת בפני עצמה. בלי לחזור על מה שכבר קיים.
אל תכתוב סכומים בשקלים. אחוזים ותקופות — רק ערכים מקובלים וסבירים.`;
  }
  return `${ctx}\nהערות קיימות: ${q.comments || "(אין)"}\n\nהצע 4 שורות קצרות של הערות ללקוח בתחתית ההצעה:
מה המחיר כולל, מה הלקוח צריך להכין או לספק, זמני ביצוע כלליים, ושורת תודה. כל שורה עומדת בפני עצמה. בלי לחזור על מה שכבר קיים.
אל תכתוב סכומים בשקלים ואל תמציא פרטים ספציפיים (תאריכים, שמות).`;
}

export async function POST(req: NextRequest) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const v = verifyToken(bearer);
  if (!v.valid) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "not_configured" }, { status: 503 });

  let body: { kind?: Kind; quote?: Partial<QuoteV2>; index?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const kind = body.kind;
  if (kind !== "item" && kind !== "notes" && kind !== "terms") return Response.json({ error: "bad_kind" }, { status: 400 });
  const q = body.quote && typeof body.quote === "object" ? body.quote : {};
  const index = Number(body.index ?? 0);
  if (kind === "item" && !q.items?.[index]) return Response.json({ error: "bad_index" }, { status: 400 });

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      messages: [
        { role: "system", content: "אתה עוזר לבעלי מקצוע בישראל לנסח הצעות מחיר. כתוב בעברית מקצועית, פשוטה וקצרה." },
        { role: "user", content: prompt(kind, q, index, v.payload.industry, v.payload.company_name) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "suggestions", strict: true, schema: kind === "item" ? ITEM_SCHEMA : LINES_SCHEMA },
      },
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as { options?: unknown[] };
    return Response.json({ options: (parsed.options ?? []).slice(0, kind === "item" ? 3 : 4) });
  } catch (err) {
    console.error("[v2/suggest] error:", err instanceof Error ? err.message : err);
    return Response.json({ error: "ai_error" }, { status: 502 });
  }
}
