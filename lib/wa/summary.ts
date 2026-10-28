import { computeTotals, formatILS, formatQty, lineTotal } from "@/lib/v2/quote";
import type { QuoteV2 } from "@/lib/v2/quote";

/** The quote as a WhatsApp message (*bold* is WhatsApp markup). Totals come from computeTotals, never from the AI. */
export function formatSummary(q: Partial<QuoteV2>): string {
  const lines: string[] = [];
  lines.push(`*${q.title || "הצעת מחיר"}*`);
  const client = [q.client?.name, q.client?.address].filter(Boolean).join(", ");
  if (client) lines.push(`לקוח: ${client}`);
  lines.push("");

  const perItem = q.pricing_mode === "per_item";
  for (const it of q.items ?? []) {
    if (perItem) {
      const qty = it.quantity !== 1 || it.unit !== "יח'" ? `${formatQty(it.quantity)} ${it.unit} × ${formatILS(it.unit_price)} = ` : "";
      lines.push(`• ${it.name}: ${it.unit_price ? `${qty}${formatILS(lineTotal(it))}` : "_חסר מחיר_"}`);
    } else {
      lines.push(`• ${it.name}`);
    }
  }
  lines.push("");

  const t = computeTotals(q);
  if (!perItem && !t.subtotal) {
    lines.push("_עוד אין מחיר_");
  } else {
    if (t.discount) {
      lines.push(`סה״כ: ${formatILS(t.subtotal)}`);
      lines.push(`הנחה: −${formatILS(t.discount)}`);
    }
    if (q.has_tax) {
      lines.push(`לפני מע״מ: ${formatILS(t.beforeVat)}`);
      lines.push(`מע״מ 18%: ${formatILS(t.vat)}`);
    }
    lines.push(`*לתשלום: ${formatILS(t.grandTotal)}*${q.has_tax === false ? " (בלי מע״מ)" : ""}`);
    if (t.missingPrices) lines.push(`_${t.missingPrices === 1 ? "פריט אחד" : `${t.missingPrices} פריטים`} בלי מחיר_`);
  }
  return lines.join("\n");
}
