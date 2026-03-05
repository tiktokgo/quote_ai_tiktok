import { NextRequest } from "next/server";
import type { PartialQuote } from "@/lib/quoteSchema";

export async function POST(req: NextRequest) {
  const url = process.env.BUBBLE_ONBOARD_URL;
  const key = process.env.BUBBLE_API_KEY;

  if (!url) {
    console.warn("BUBBLE_ONBOARD_URL not configured — skipping webhook");
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { company_name: string; email: string; industry: string; quote: PartialQuote };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, message: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { company_name, email, industry, quote } = body;

  const payload: Record<string, unknown> = {
    status:       "new_lead",
    company_name,
    email,
    industry,
  };
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
  payload.has_tax = quote.has_tax ?? false;
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
      console.warn(`Onboard webhook non-2xx: HTTP ${res.status} — ${responseText}`);
    }

    let quote_id: string | undefined;
    let redirect_url: string | undefined;
    try {
      const json = JSON.parse(responseText);
      quote_id = json.quote_id ?? json.response?.quote_id;
      redirect_url = json.redirect_url ?? json.response?.redirect_url;
    } catch { /* ignore */ }

    console.log(`Onboard webhook OK: HTTP ${res.status} email:${email} quote_id:${quote_id} redirect_url:${redirect_url}`);
    return new Response(JSON.stringify({ ok: true, quote_id, redirect_url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Onboard webhook error:", msg);
    return new Response(JSON.stringify({ ok: false, message: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
