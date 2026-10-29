import { computeTotals, formatILS, formatQty, lineTotal } from "@/lib/v2/quote";
import type { WaQuote } from "./ai";

// Starts each list line right-to-left, so WhatsApp keeps the bullet on the right.
const RLM = "‏";
const NOTE_MAX = 160;
const DETAILS_UP_TO = 3;
const short = (s: string) => (s.length > NOTE_MAX ? `${s.slice(0, NOTE_MAX).trim()}…` : s);

/**
 * The quote as a WhatsApp message (*bold* is WhatsApp markup). Totals come from computeTotals, never from the AI.
 * The quote comes first and every question at the end, once: the AI's own text (aiText) goes last,
 * and the fixed questions (price, VAT, client) are skipped when the AI already asked them.
 */
export function formatSummary(q: WaQuote, aiText = ""): string {
  const lines: string[] = [];
  lines.push(`*${q.title || "הצעת מחיר"}*`);
  const client = [q.client?.name, q.client?.address].filter(Boolean).join(", ");
  if (client) lines.push(`לקוח: ${client}`);
  lines.push("");

  const perItem = q.pricing_mode === "per_item";
  // With a few items, show what each includes; a long list stays one line per item.
  const withDetails = (q.items?.length ?? 0) <= DETAILS_UP_TO;
  for (const it of q.items ?? []) {
    if (perItem) {
      const qty = it.quantity !== 1 || it.unit !== "יח'" ? `${formatQty(it.quantity)} ${it.unit} × ${formatILS(it.unit_price)} = ` : "";
      lines.push(`${RLM}• ${it.name}: ${it.unit_price ? `${qty}${formatILS(lineTotal(it))}` : "_חסר מחיר_"}`);
    } else {
      lines.push(`${RLM}• ${it.name}`);
    }
    if (withDetails && it.description?.trim()) lines.push(`${RLM}   _${short(it.description.trim())}_`);
  }
  lines.push("");

  const t = computeTotals(q);
  const noPrice = !perItem && !t.subtotal;
  if (!noPrice) {
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

  const notes = [
    q.comments && `📝 הערות: ${short(q.comments)}`,
    q.warranty && `🛡️ אחריות: ${short(q.warranty)}`,
    q.terms && `📄 תנאים: ${short(q.terms)}`,
  ].filter(Boolean) as string[];
  if (notes.length) lines.push("", ...notes);

  // runTurn keeps this list in the same order, so "תוסיף 1 ו-3" means these numbers.
  if (q.suggested_items?.length) {
    lines.push("", "*אפשר להוסיף גם:*");
    q.suggested_items.forEach((s, i) => lines.push(`${i + 1}. ${s.name}`));
    lines.push("_רוצים? כתבו את המספרים, למשל: תוסיף 1 ו-3_");
  }

  const ai = aiText.trim();
  const questions: string[] = [];
  if (noPrice && !/מחיר|כמה/.test(ai)) questions.push("💰 מה המחיר שתרצו?");
  if (!noPrice && q.has_tax === undefined && !/מע.?מ/.test(ai)) questions.push("להוסיף מע״מ למחיר?");
  if (!q.client?.name && !/לקוח|למי/.test(ai)) questions.push("על הדרך, רשמו לי גם את שם הלקוח שאשים על ההצעה 🙂");
  if (ai) questions.unshift(ai);
  if (questions.length) lines.push("", ...questions);
  return lines.join("\n");
}
