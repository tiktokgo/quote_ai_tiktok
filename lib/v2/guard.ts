import type { QuoteV2, QuoteUpdateV2 } from "./quote";

/**
 * The model sometimes answers a small message ("רונאל") by re-sending a whole new draft,
 * wiping items, terms and notes the user had edited. Drop the parts of the update the
 * last user message did not ask about.
 */
export function guardUpdate(current: Partial<QuoteV2>, update: QuoteUpdateV2, lastUser: string): QuoteUpdateV2 {
  const u: QuoteUpdateV2 = { ...update };
  const says = (re: RegExp) => re.test(lastUser);
  const dropped: string[] = [];

  if (current.items?.length && Array.isArray(u.items)) {
    const next = new Set(u.items.map((it) => (it?.name ?? "").trim()));
    const removed = current.items.filter((it) => !next.has(it.name.trim())).length;
    const allowsRemoval = says(/מחק|תמחק|הסר|תסיר|תוריד|להוריד|בלי |במקום|תחליף|להחליף|תשנה|לשנות|מחדש|הצעה חדשה|רק |איחוד|תאחד|תפצל/);
    // Renaming one item is fine; losing two or more without being asked is not.
    if (removed >= 2 && !allowsRemoval) { delete u.items; dropped.push("items"); }
  }
  const keepIfSet = (k: "warranty" | "terms" | "comments" | "title", re: RegExp) => {
    // warranty and terms share one box on the page — guard them together.
    const cur = (k === "warranty" || k === "terms" ? `${current.warranty ?? ""}${current.terms ?? ""}` : current[k] ?? "").trim();
    if (cur && (k === "warranty" || k === "terms") && typeof u[k] === "string" && !says(re)) { delete u[k]; dropped.push(k); return; }
    if (cur && typeof u[k] === "string" && u[k]!.trim() !== cur && !says(re)) { delete u[k]; dropped.push(k); }
  };
  keepIfSet("warranty", /אחריות|תנא/);
  keepIfSet("terms", /תנא|תשלום|מקדמה|שוטף|אחריות|תוקף/);
  keepIfSet("comments", /הער/);
  keepIfSet("title", /כותרת|שם ההצעה/);
  if (current.has_tax !== undefined && u.has_tax !== undefined && u.has_tax !== current.has_tax && !says(/מע["״'׳]?מ|מעמ/)) {
    delete u.has_tax; dropped.push("has_tax");
  }
  if (u.price_includes_vat && !says(/מע["״'׳]?מ|מעמ/)) {
    delete u.price_includes_vat; dropped.push("price_includes_vat");
  }
  if ((current.total ?? 0) > 0 && u.total !== undefined && u.total !== current.total && !/\d/.test(lastUser) && !says(/אלף|מאות|שקל/)) {
    delete u.total; dropped.push("total");
  }
  if (dropped.length) console.log(`[v2/chat] guard dropped: ${dropped.join(",")}`);
  return u;
}
