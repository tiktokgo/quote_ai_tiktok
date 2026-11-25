/**
 * People send receipts in bursts (5 photos, one message each). Each file is saved at once, but the
 * user gets ONE answer: "✅ התקבלו 5 קבצים". No extra table — the wa_message rows in v2_events
 * (props.result "expense_saved" / "expense_replied") are the batch state.
 *
 * Every file: save → log expense_saved with its own marker → wait QUIET_MS → if a newer file
 * arrived, that one answers; otherwise count the files saved since the last answer and reply.
 */

export const QUIET_MS = 15_000;
const WINDOW_MS = 10 * 60_000;

type Row = { created_at: string; props: { result?: string; batch?: string } };

function rest(path: string): Promise<Response> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase not configured");
  return fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    // Same key handling as lib/v2/track.ts
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(5000),
  });
}

async function recent(contactId: string, results: string[], windowMs = WINDOW_MS): Promise<Row[]> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const q = [
    `session_id=eq.${encodeURIComponent(`wa:${contactId}`)}`,
    "event=eq.wa_message",
    `props->>result=in.(${results.join(",")})`,
    `created_at=gte.${encodeURIComponent(since)}`,
    "select=created_at,props",
    "order=created_at.desc",
    "limit=50",
  ].join("&");
  const res = await rest(`v2_events?${q}`);
  if (!res.ok) throw new Error(`v2_events read HTTP ${res.status}`);
  return (await res.json()) as Row[];
}

/** Files saved in this burst, or null when a newer file will answer instead. */
export function countBurst(rows: Row[], marker: string, result = "expense_saved"): number | null {
  if (!rows.length || rows[0].props.result !== result || rows[0].props.batch !== marker) return null;
  let n = 0;
  for (const r of rows) {
    if (r.props.result !== result) break;
    n++;
  }
  return n;
}

/** result = this file's row ("expense_saved"), replied = the answer's row ("expense_replied"). */
export async function burstCount(contactId: string, marker: string, result: string, replied: string): Promise<number | null> {
  await new Promise((r) => setTimeout(r, QUIET_MS));
  return countBurst(await recent(contactId, [result, replied]), marker, result);
}

/** True when the user already got this answer in the window (default 10 minutes: "upgrade" once per burst; the menu: 30 days). */
export async function answeredRecently(contactId: string, result: string, windowMs = WINDOW_MS): Promise<boolean> {
  return (await recent(contactId, [result], windowMs)).length > 0;
}

/** Files in the open burst (since the last answer), newest first. */
export function openBurst(rows: Row[], result: string): Row[] {
  const open: Row[] = [];
  for (const r of rows) {
    if (r.props.result !== result) break;
    open.push(r);
  }
  return open;
}

/** True when this file opened a new burst: it gets the immediate "✅ התקבל". */
export async function firstInBurst(contactId: string, marker: string, result: string, replied: string): Promise<boolean> {
  const open = openBurst(await recent(contactId, [result, replied]), result);
  return open.length === 1 && open[0].props.batch === marker;
}
