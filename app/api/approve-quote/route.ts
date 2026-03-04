import { NextRequest } from "next/server";
import type { PartialQuote } from "@/lib/quoteSchema";

export async function POST(req: NextRequest) {
  const url = process.env.BUBBLE_WEBHOOK_URL;
  const key = process.env.BUBBLE_API_KEY;

  if (!url) {
    return new Response(JSON.stringify({ ok: false, message: "BUBBLE_WEBHOOK_URL not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { user_id?: string; quote: PartialQuote };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, message: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { user_id, quote } = body;

  // Build full payload — include every field
  const payload: Record<string, unknown> = { status: "complete" };
  if (user_id)                   payload.user_id       = user_id;
  if (quote.title)                payload.title          = quote.title;
  if (quote.client?.name)         payload.client_name    = quote.client.name;
  if (quote.client?.address)      payload.client_address = quote.client.address;
  if (quote.client?.phone)        payload.client_phone   = quote.client.phone;
  if (quote.client?.email)        payload.client_email   = quote.client.email;
  if (quote.items && quote.items.length > 0) {
    payload.items = quote.items.map((item) => ({
      name:        item.name        ?? "",
      description: item.description ?? "",
    }));
  }
  if (quote.total      !== undefined) payload.total      = quote.total;
  if (quote.has_tax    !== undefined) payload.has_tax    = quote.has_tax;
  if (quote.tax_amount !== undefined) payload.tax_amount = quote.tax_amount;
  if (quote.warranty)                 payload.warranty   = quote.warranty;
  if (quote.terms)                    payload.terms      = quote.terms;
  if (quote.comments)                 payload.comments   = quote.comments;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    const responseText = await res.text().catch(() => "");
    if (!res.ok) {
      console.error(`Approve webhook failed: HTTP ${res.status} — ${responseText}`);
      return new Response(JSON.stringify({ ok: false, message: `HTTP ${res.status}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`Approve webhook OK: HTTP ${res.status} user_id:${user_id}`);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Approve webhook error:", msg);
    return new Response(JSON.stringify({ ok: false, message: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
