import { NextRequest } from "next/server";

/**
 * GET /api/test-bubble?api_key=TOKEN_API_KEY&quote_id=TEST-123
 *
 * Fires a complete sample payload to BUBBLE_WEBHOOK_URL with every
 * possible field populated. Use this once to initialize all field types
 * in Bubble, then you can remove the initialize flag.
 */
export async function GET(req: NextRequest) {
  const apiKey = process.env.TOKEN_API_KEY;
  const { searchParams } = new URL(req.url);

  if (apiKey && searchParams.get("api_key") !== apiKey) {
    return new Response(JSON.stringify({ error: "Invalid api_key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = process.env.BUBBLE_WEBHOOK_URL;
  const key = process.env.BUBBLE_API_KEY;
  if (!url) {
    return new Response(JSON.stringify({ error: "BUBBLE_WEBHOOK_URL not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const quoteId = searchParams.get("quote_id") ?? "TEST-INIT-001";

  const fullPayload = {
    quote_id:       quoteId,
    title:          "הצעת מחיר — אינסטלציה — רחוב הרצל 5",
    client_name:    "ישראל ישראלי",
    client_address: "רחוב הרצל 5, תל אביב",
    items: [
      { name: "פריט לדוגמה",    description: "תיאור מפורט של הפריט הראשון" },
      { name: "פריט שני",       description: "תיאור מפורט של הפריט השני" },
      { name: "פריט שלישי",     description: "תיאור מפורט של הפריט השלישי" },
    ],
    total:      5000,
    has_tax:    true,
    tax_amount: 900,
    warranty:   "אחריות עבודה לשנה. אחריות יצרן בהתאם למוצר.",
    terms:      "50% מקדמה לקביעת מועד העבודה. יתרה בתשלום עם סיום.",
    comments:   "הערה לדוגמה לאתחול שדות",
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(fullPayload),
      signal: AbortSignal.timeout(8000),
    });

    const responseText = await res.text().catch(() => "");
    return new Response(
      JSON.stringify({
        ok:      res.ok,
        status:  res.status,
        sent:    fullPayload,
        bubble:  responseText.slice(0, 300),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
