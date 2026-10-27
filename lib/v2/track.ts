/**
 * v2 usage events → Supabase table `v2_events` (see tiktok-hq/docs/snippets/v2_events.sql).
 * What people did and what it cost — never quote content or client names.
 * No-op when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set (local dev, previews).
 * Call it inside next/server `after()` so it never slows a response.
 */

export type Props = Record<string, string | number | boolean | null>;

export interface TrackEvent {
  event: string;
  user_id?: string;
  session_id?: string;
  props?: Props;
  cost_usd?: number;
}

/** USD per 1M tokens (OpenAI list prices, Oct 2026 — an estimate for the dashboard, not billing). */
const PRICES: Record<string, { in: number; out: number; audioIn?: number }> = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-transcribe": { in: 2.5, out: 10, audioIn: 6 },
};

type Usage = { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number;
  input_token_details?: { audio_tokens?: number; text_tokens?: number } } | null | undefined;

export function costUsd(model: string, usage: Usage): number | undefined {
  const p = PRICES[model];
  if (!p || !usage) return undefined;
  const audio = usage.input_token_details?.audio_tokens ?? 0;
  const inTok = (usage.prompt_tokens ?? usage.input_tokens ?? 0) - audio;
  const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return (inTok * p.in + outTok * p.out + audio * (p.audioIn ?? p.in)) / 1e6;
}

/** Keeps props small and flat: numbers, booleans and short strings only. */
export function cleanProps(raw: unknown): Props {
  const out: Props = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 12)) {
    const key = k.slice(0, 40);
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean" || v === null) out[key] = v;
    else if (typeof v === "string") out[key] = v.slice(0, 60);
  }
  return out;
}

export async function track(...events: TrackEvent[]): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !events.length) return;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/v2_events`, {
      method: "POST",
      // New Supabase secret keys (sb_secret_…) go in `apikey` only; a legacy service_role JWT also as Bearer.
      headers: { "Content-Type": "application/json", apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), Prefer: "return=minimal" },
      body: JSON.stringify(events.map((e) => ({
        event: e.event.slice(0, 40),
        user_id: e.user_id ?? null,
        session_id: e.session_id?.slice(0, 40) ?? null,
        props: e.props ?? {},
        cost_usd: e.cost_usd ?? null,
      }))),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) console.warn(`[track] HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  } catch (e) {
    console.warn("[track] failed:", e instanceof Error ? e.message : e);
  }
}

/** The page sends its session id (one per page load) on every v2 call. */
export const sessionOf = (req: Request) => req.headers.get("x-v2-session")?.slice(0, 40) || undefined;
