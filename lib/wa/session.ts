import type { ChatMessage, WaQuote } from "./ai";

/**
 * One open quote conversation per WhatsApp contact — Supabase table `wa_sessions`
 * (tiktok-hq/docs/snippets/wa_sessions.sql). The /v2 page keeps this in the browser;
 * WhatsApp has no browser, so it lives here. Deleted after save or cancel.
 */

export interface WaSession {
  contact_id: string;
  user_id: string;
  messages: ChatMessage[];
  quote: WaQuote;
  updated_at?: string;
}

/** A conversation left for a day starts over. */
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_MESSAGES = 30;

function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase not configured");
  return fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init,
    // Same key handling as lib/v2/track.ts
    headers: { "Content-Type": "application/json", apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), ...init.headers },
    signal: AbortSignal.timeout(5000),
  });
}

const enc = encodeURIComponent;

/** The open session, or null when there is none, it is stale, or it belongs to another user. */
export async function loadSession(contactId: string, userId: string): Promise<WaSession | null> {
  const res = await rest(`wa_sessions?contact_id=eq.${enc(contactId)}&select=*`);
  if (!res.ok) throw new Error(`wa_sessions load HTTP ${res.status}`);
  const s = ((await res.json()) as WaSession[])[0];
  if (!s || s.user_id !== userId) return null;
  if (s.updated_at && Date.now() - new Date(s.updated_at).getTime() > MAX_AGE_MS) {
    await deleteSession(contactId);
    return null;
  }
  return s;
}

export async function saveSession(s: WaSession): Promise<void> {
  const res = await rest("wa_sessions", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      contact_id: s.contact_id,
      user_id: s.user_id,
      messages: s.messages.slice(-MAX_MESSAGES),
      quote: s.quote,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`wa_sessions save HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

export async function deleteSession(contactId: string): Promise<void> {
  const res = await rest(`wa_sessions?contact_id=eq.${enc(contactId)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`wa_sessions delete HTTP ${res.status}`);
}
