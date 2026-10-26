/**
 * v2 quote model — one quote shape for "total" (one price for everything) and
 * "per_item" (quantity × unit price per line).
 *
 * Decisions (tiktok-hq/docs/decisions.md):
 * - the AI never computes money; totals, discount and VAT are computed here (display)
 *   and by Bubble (source of truth)
 * - a per_item line without a price is sent as 0
 * - discount is sent to Bubble as an amount in ₪ only
 */

/** Must match the Bubble option set `unit_type` (Display) exactly. */
export const UNITS = ["יח'", "כמות", "מ\"ר", "מ'", "מטר", "מידה", "ק\"ג", "שעות", "יום"] as const;
export const DEFAULT_UNIT = "יח'";
export const VAT_RATE = 0.18;

export type PricingMode = "total" | "per_item";

export interface QuoteItemV2 {
  name: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
}

export interface ClientV2 {
  name?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export interface QuoteV2 {
  pricing_mode: PricingMode;
  title: string;
  date: string;
  industry: string;
  client: ClientV2;
  items: QuoteItemV2[];
  /** total mode only: the one price the user said */
  total: number;
  has_tax: boolean;
  /** per_item only, in ₪ */
  discount_amount: number;
  warranty: string;
  terms: string;
  comments: string;
}

/** What the AI sends in update_quote (every field optional). */
export type QuoteUpdateV2 = Partial<Omit<QuoteV2, "client" | "items">> & {
  client?: Partial<ClientV2>;
  items?: Partial<QuoteItemV2>[];
  /** per_item only; converted to discount_amount here */
  discount_percent?: number;
  /** Related items the user did NOT mention — shown as "add?" chips, never put in the quote by themselves. */
  suggested_items?: { name: string; description?: string }[];
};

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

export function normalizeUnit(u: unknown): string {
  const s = typeof u === "string" ? u.trim() : "";
  if (!s) return DEFAULT_UNIT;
  if ((UNITS as readonly string[]).includes(s)) return s;
  // Common spellings the model may still use
  const aliases: Record<string, string> = {
    'מ"א': "מ'", "מטר אורך": "מ'", "מ״א": "מ'", "מ״ר": 'מ"ר', "מטר רבוע": 'מ"ר', "מ\"ר.": 'מ"ר',
    "יחידה": "יח'", "יחידות": "יח'", "יח": "יח'", "שעה": "שעות", "ימים": "יום", "קג": 'ק"ג', "ק״ג": 'ק"ג',
  };
  return aliases[s] ?? DEFAULT_UNIT;
}

export function normalizeItem(it: Partial<QuoteItemV2> | undefined): QuoteItemV2 {
  const quantity = num(it?.quantity, 1);
  return {
    name: (it?.name ?? "").toString().trim(),
    description: (it?.description ?? "").toString().trim(),
    quantity: quantity > 0 ? quantity : 1,
    unit: normalizeUnit(it?.unit),
    unit_price: Math.max(0, num(it?.unit_price, 0)),
  };
}

export const lineTotal = (it: QuoteItemV2): number => round2(it.quantity * it.unit_price);
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface Totals {
  subtotal: number;        // per_item: Σ lines; total mode: the total
  discount: number;
  beforeVat: number;
  vat: number;
  grandTotal: number;
  missingPrices: number;   // per_item lines with price 0
}

/**
 * per_item: VAT is added on top of the lines (after discount) when has_tax.
 * total:    the said total is the final amount — nothing is added or subtracted
 *           (same behaviour as the existing /chat flow).
 */
export function computeTotals(q: Partial<QuoteV2>): Totals {
  if (q.pricing_mode === "per_item") {
    const items = q.items ?? [];
    const subtotal = round2(items.reduce((s, it) => s + lineTotal(it), 0));
    const discount = round2(Math.min(Math.max(0, q.discount_amount ?? 0), subtotal));
    const beforeVat = round2(subtotal - discount);
    const vat = q.has_tax ? round2(beforeVat * VAT_RATE) : 0;
    return {
      subtotal, discount, beforeVat, vat,
      grandTotal: round2(beforeVat + vat),
      missingPrices: items.filter((it) => !it.unit_price).length,
    };
  }
  // total mode: the said amount is final. With has_tax ("the price includes VAT") we only
  // show how it splits — nothing is added on top.
  const total = Math.max(0, q.total ?? 0);
  const beforeVat = q.has_tax ? round2(total / (1 + VAT_RATE)) : total;
  return { subtotal: total, discount: 0, beforeVat, vat: round2(total - beforeVat), grandTotal: total, missingPrices: 0 };
}

/** Merge an AI update into the current quote. Items are always replaced as a full list. */
export function mergeQuoteV2(current: Partial<QuoteV2>, update: QuoteUpdateV2): Partial<QuoteV2> {
  const m: Partial<QuoteV2> = { ...current };
  if (update.pricing_mode === "total" || update.pricing_mode === "per_item") m.pricing_mode = update.pricing_mode;
  for (const k of ["title", "date", "industry", "warranty", "terms", "comments"] as const) {
    if (typeof update[k] === "string") m[k] = update[k] as string;
  }
  if (typeof update.has_tax === "boolean") m.has_tax = update.has_tax;
  if (update.total !== undefined) m.total = Math.max(0, num(update.total, 0));
  if (update.items !== undefined && Array.isArray(update.items)) {
    m.items = update.items.map(normalizeItem).filter((it) => it.name);
  }
  if (update.client) m.client = { ...(current.client ?? {}), ...update.client };
  if (!m.pricing_mode) m.pricing_mode = "total";

  if (m.pricing_mode === "per_item") {
    if (update.discount_amount !== undefined) {
      m.discount_amount = Math.max(0, num(update.discount_amount, 0));
    } else if (update.discount_percent !== undefined) {
      const sub = computeTotals({ ...m, discount_amount: 0 }).subtotal;
      m.discount_amount = round2((sub * Math.max(0, num(update.discount_percent, 0))) / 100);
    }
  }
  return m;
}

/** Switch mode by hand. total → per_item keeps the lines (price 0); per_item → total keeps the sum. */
export function switchMode(q: Partial<QuoteV2>, mode: PricingMode): Partial<QuoteV2> {
  if (q.pricing_mode === mode) return q;
  if (mode === "total") {
    return { ...q, pricing_mode: "total", total: computeTotals(q).grandTotal || q.total || 0, discount_amount: 0 };
  }
  return { ...q, pricing_mode: "per_item", items: (q.items ?? []).map(normalizeItem) };
}

export function formatILS(n: number): string {
  return new Intl.NumberFormat("he-IL", {
    style: "currency", currency: "ILS",
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2,
  }).format(n);
}

export function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round2(n));
}

// ── Bubble payloads ─────────────────────────────────────────────────────────

/** update_quote (existing workflow) — same fields the current /api/approve-quote sends. */
export function buildTotalPayload(q: Partial<QuoteV2>, userId: string): Record<string, unknown> {
  const p: Record<string, unknown> = { status: "complete", user_id: userId };
  if (q.title) p.title = q.title;
  if (q.client?.name) p.client_name = q.client.name;
  if (q.client?.address) p.client_address = q.client.address;
  if (q.client?.phone) p.client_phone = q.client.phone;
  if (q.client?.email) p.client_email = q.client.email;
  if (q.items?.length) p.items = q.items.map((it) => ({ name: it.name, description: it.description ?? "" }));
  p.total = q.total ?? 0;
  p.has_tax = q.has_tax ?? false;
  if (q.warranty) p.warranty = q.warranty;
  if (q.terms) p.terms = q.terms;
  if (q.comments) p.comments = q.comments;
  return p;
}

/** update_quote_per_item — matches the request data detected in Bubble on 2026-10-26. */
export function buildPerItemPayload(q: Partial<QuoteV2>, userId: string, source = "chat"): Record<string, unknown> {
  const t = computeTotals(q);
  return {
    status: "draft",
    source,
    user_id: userId,
    title: q.title ?? "",
    client_name: q.client?.name ?? "",
    client_address: q.client?.address ?? "",
    client_phone: q.client?.phone ?? "",
    client_email: q.client?.email ?? "",
    items: (q.items ?? []).map((it, i) => ({
      order: i + 1,
      name: it.name,
      description: it.description ?? "",
      quantity: it.quantity,
      unit: normalizeUnit(it.unit),
      unit_price: it.unit_price,
    })),
    has_tax: q.has_tax ?? false,
    discount_amount: t.discount,
    warranty: q.warranty ?? "",
    terms: q.terms ?? "",
    comments: q.comments ?? "",
  };
}

/** https://host/api/1.1/... → https://host/version-test/api/1.1/... (no-op if already there). */
export function toBubbleTest(url: string): string {
  if (url.includes("/version-test/")) return url;
  return url.replace(/^(https?:\/\/[^/]+)\//, "$1/version-test/");
}
