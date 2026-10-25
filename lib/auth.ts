import { timingSafeEqual } from "crypto";
import { verifyToken } from "./verifyToken";

/** Constant-time string compare (API keys) */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The logged-in user's id, taken ONLY from a valid JWT (Authorization: Bearer).
 * Never trust a user_id sent in the request body.
 */
export function userIdFromRequest(req: Request): { ok: true; userId: string } | { ok: false; reason: string } {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!bearer) return { ok: false, reason: "Missing token" };
  const v = verifyToken(bearer);
  if (!v.valid) return { ok: false, reason: v.reason };
  if (!v.payload.user_id) return { ok: false, reason: "Token has no user_id" };
  return { ok: true, userId: v.payload.user_id };
}
