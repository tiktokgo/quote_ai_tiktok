import jwt from "jsonwebtoken";
import { createHmac, randomUUID } from "crypto";
import type { AIContext } from "../verifyToken";

/**
 * v2 for guests (the chat embedded on the marketing site, no account yet).
 *
 * A guest gets a short-lived token signed here, on page load. It has no company_name /
 * industry / user_id, so verifyToken() rejects it — every logged-in-only route
 * (approve, upload-photo, read-file, suggest, review) stays closed to guests.
 *
 * What a guest may do (decision 2026-11-23): ONE message to the AI (text or voice) and
 * ONE recording of up to 20 seconds. After that: "sign up for free".
 * The limit is enforced here, on the server, by guest id AND by IP (a refresh gives a
 * new guest id, the IP stays). Counts live in Supabase v2_events (no new table).
 */

export const GUEST_CONTEXT: AIContext = { company_name: "העסק שלך", industry: "כללי" };
export const GUEST_USER_ID = "guest";
export const GUEST_MAX_REC_SEC = 20;
/** Opus / AAC for 20 seconds is well under this; anything bigger is not a 20-second recording. */
export const GUEST_MAX_AUDIO_BYTES = 700 * 1024;

const TOKEN_TTL = "6h";
/** Per guest id: one of each. Per IP per 24h: a little more, for offices that share one IP. */
const LIMITS = { ai: { perGuest: 1, perIp: 3 }, voice: { perGuest: 1, perIp: 3 } } as const;
export type GuestKind = keyof typeof LIMITS;

export function signGuestToken(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return jwt.sign({ typ: "guest", gid: randomUUID() }, secret, { expiresIn: TOKEN_TTL });
}

/** The guest id from a valid guest token, or null. */
export function verifyGuestToken(token: string): string | null {
  const secret = process.env.JWT_SECRET;
  if (!secret || !token) return null;
  try {
    const p = jwt.verify(token, secret) as { typ?: string; gid?: string };
    return p.typ === "guest" && typeof p.gid === "string" && p.gid ? p.gid.slice(0, 40) : null;
  } catch {
    return null;
  }
}

export const bearerOf = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";

/** The caller's IP, hashed (we never store the IP itself). */
function ipHash(req: Request): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  return createHmac("sha256", process.env.JWT_SECRET ?? "").update(ip).digest("hex").slice(0, 16);
}

function supabase(): { url: string; headers: Record<string, string> } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return {
    url: `${url.replace(/\/$/, "")}/rest/v1/v2_events`,
    headers: { "Content-Type": "application/json", apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}) },
  };
}

/**
 * Take one use of `kind` for this guest. Insert first, then count the rows up to ours:
 * two requests at the same moment can't both be "the first one".
 * Fails closed: if the count can't be checked in production, the guest is refused.
 */
export async function takeGuestUse(req: Request, gid: string, kind: GuestKind, sessionId?: string): Promise<boolean> {
  const db = supabase();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      console.error("[guest] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — guests refused");
      return false;
    }
    return true; // local dev without Supabase
  }
  const event = `guest_${kind}`;
  const ip = ipHash(req);
  try {
    const ins = await fetch(db.url, {
      method: "POST",
      headers: { ...db.headers, Prefer: "return=representation" },
      body: JSON.stringify({ event, user_id: GUEST_USER_ID, session_id: sessionId?.slice(0, 40) ?? null, props: { gid, ip } }),
      signal: AbortSignal.timeout(4000),
    });
    if (!ins.ok) throw new Error(`insert HTTP ${ins.status}`);
    const id = ((await ins.json()) as { id?: number }[])[0]?.id;
    if (!id) throw new Error("insert returned no id");

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const count = async (filter: string, cap: number) => {
      const r = await fetch(`${db.url}?select=id&event=eq.${event}&id=lte.${id}&${filter}&limit=${cap + 1}`, {
        headers: db.headers,
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) throw new Error(`count HTTP ${r.status}`);
      return ((await r.json()) as unknown[]).length;
    };
    const lim = LIMITS[kind];
    const [byGuest, byIp] = await Promise.all([
      count(`props->>gid=eq.${encodeURIComponent(gid)}`, lim.perGuest),
      count(`props->>ip=eq.${ip}&created_at=gte.${encodeURIComponent(since)}`, lim.perIp),
    ]);
    const ok = byGuest <= lim.perGuest && byIp <= lim.perIp;
    if (!ok) console.log(`[guest] ${kind} refused: guest=${byGuest} ip=${byIp}`);
    return ok;
  } catch (e) {
    console.error("[guest] limit check failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Added to the system prompt for guests: they get one message, so build everything from it. */
export const GUEST_PROMPT = `## אורח — הודעה אחת בלבד
זה אורח מהאתר, בלי חשבון. הוא שולח הודעה אחת בלבד ולא יוכל לענות על שאלות.
- הפעל update_quote בכל מקרה, עם טיוטה מלאה מההודעה הזאת: title, items, warranty, terms, ומה שנאמר על הלקוח והמחיר.
- לא נאמר מחיר → total=0. לא נאמר לקוח → בלי client.
- בטקסט: משפט אחד בלבד, שההצעה מוכנה ושאפשר להשלים ולערוך אותה ידנית בחלון ההצעה. בלי שאלות.`;
