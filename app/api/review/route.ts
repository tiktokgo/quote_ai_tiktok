import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const url = process.env.REVIEW_WEBHOOK_URL;
  const key = process.env.BUBBLE_API_KEY;

  let body: { quote_id?: string; stars: number; comment?: string; user_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, message: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`Review received: stars=${body.stars} quote_id=${body.quote_id} user_id=${body.user_id}`);

  if (!url) {
    // No webhook configured — log and return ok so the UI flow continues
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ ...body, type: "quote_review" }),
      signal: AbortSignal.timeout(8000),
    });

    const responseText = await res.text().catch(() => "");
    console.log(`Review webhook: HTTP ${res.status} — ${responseText}`);
    return new Response(JSON.stringify({ ok: res.ok }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Review webhook error:", msg);
    return new Response(JSON.stringify({ ok: false, message: msg }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
