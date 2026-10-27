import { NextRequest, after } from "next/server";
import { userIdFromRequest } from "@/lib/auth";
import { buildPerItemPayload, buildTotalPayload, toBubbleTest, computeTotals } from "@/lib/v2/quote";
import { track, sessionOf } from "@/lib/v2/track";
import type { QuoteV2 } from "@/lib/v2/quote";

/**
 * POST /api/v2/approve-quote — saves the quote as a draft in Bubble.
 *   total    → update_quote          (BUBBLE_WEBHOOK_URL, existing workflow)
 *   per_item → update_quote_per_item (BUBBLE_PER_ITEM_URL, or derived from BUBBLE_WEBHOOK_URL)
 * bubble_env "test" sends to version-test (the page was opened from Bubble's version-test).
 * Returns ok:false whenever Bubble did not confirm — the UI must not show success.
 */
export async function POST(req: NextRequest) {
  const auth = userIdFromRequest(req);
  if (!auth.ok) return Response.json({ ok: false, message: "Unauthorized" }, { status: 401 });

  let body: { quote?: Partial<QuoteV2>; bubble_env?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
  }
  const quote = body.quote;
  if (!quote || typeof quote !== "object") {
    return Response.json({ ok: false, message: "Missing quote" }, { status: 400 });
  }

  const base = process.env.BUBBLE_WEBHOOK_URL;
  const key = process.env.BUBBLE_API_KEY;
  if (!base) return Response.json({ ok: false, message: "BUBBLE_WEBHOOK_URL not configured" }, { status: 503 });

  const perItem = quote.pricing_mode === "per_item";
  let url = perItem
    ? process.env.BUBBLE_PER_ITEM_URL || base.replace(/update_quote\/?$/, "update_quote_per_item")
    : base;
  const isTest = body.bubble_env === "test";
  if (isTest) url = toBubbleTest(url);

  const payload = perItem ? buildPerItemPayload(quote, auth.userId) : buildTotalPayload(quote, auth.userId);
  const t = computeTotals(quote);
  const report = (ok: boolean, error: string | null) =>
    after(() => track({ event: "saved", user_id: auth.userId, session_id: sessionOf(req), props: {
      ok, error, test: isTest, mode: perItem ? "per_item" : "total", items: quote.items?.length ?? 0,
      photos: quote.images?.length ?? 0, has_tax: !!quote.has_tax, discount: t.discount > 0,
      missing_prices: t.missingPrices, amount: Math.round(t.grandTotal),
    } }));

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text().catch(() => "");
    console.log(`[v2/approve] mode:${perItem ? "per_item" : "total"} test:${isTest} HTTP ${res.status} items:${quote.items?.length ?? 0}`);
    if (!res.ok) {
      console.warn(`[v2/approve] Bubble error: ${text.slice(0, 300)}`);
      report(false, `bubble_${res.status}`);
      return Response.json({ ok: false, message: `bubble_${res.status}` }, { status: 502 });
    }

    let quote_id: string | undefined;
    try {
      const j = JSON.parse(text);
      quote_id = j.quote_id ?? j.response?.quote_id;
    } catch { /* ignore */ }
    report(!!quote_id, quote_id ? null : "no_quote_id");
    if (!quote_id) return Response.json({ ok: false, message: "no_quote_id" }, { status: 502 });

    const redirectBase = process.env.NEXT_PUBLIC_REDIRECT_BASE ?? "";
    const redirect_url = redirectBase ? (isTest ? toBubbleTest(redirectBase) : redirectBase) + quote_id : undefined;
    return Response.json({ ok: true, quote_id, redirect_url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[v2/approve] error:", msg);
    report(false, "network_error");
    return Response.json({ ok: false, message: "network_error" }, { status: 502 });
  }
}
