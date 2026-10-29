import { computeTotals, formatILS, formatQty, lineTotal } from "@/lib/v2/quote";
import type { WaQuote } from "./ai";

/** The quote as a WhatsApp message (*bold* is WhatsApp markup). Totals come from computeTotals, never from the AI. */
export function formatSummary(q: WaQuote): string {
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
    lines.push("💰 מה המחיר שתרצו?");
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
    if (q.has_tax === undefined) lines.push("להוסיף מע״מ למחיר?");
    if (t.missingPrices) lines.push(`_${t.missingPrices === 1 ? "פריט אחד" : `${t.missingPrices} פריטים`} בלי מחיר_`);
  }
  if (!q.client?.name) lines.push("", "על הדרך, רשמו לי גם את שם הלקוח שאשים על ההצעה 🙂");

  // runTurn keeps this list in the same order, so "תוסיף 1 ו-3" means these numbers.
  if (q.suggested_items?.length) {
    lines.push("", "*אפשר להוסיף גם:*");
    q.suggested_items.forEach((s, i) => lines.push(`${i + 1}. ${s.name}`));
    lines.push("_רוצים? כתבו את המספרים, למשל: תוסיף 1 ו-3_");
  }
  return lines.join("\n");
}
