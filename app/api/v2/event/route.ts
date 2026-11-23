import { NextRequest, after } from "next/server";
import { verifyToken } from "@/lib/verifyToken";
import { track, cleanProps, type TrackEvent } from "@/lib/v2/track";
import { verifyGuestToken, GUEST_USER_ID } from "@/lib/v2/guest";

/**
 * POST /api/v2/event — page events for the usage dashboard.
 * Body: { token, session_id, events: [{ event, props? }] } (token in the body so sendBeacon works).
 * Only known event names are kept; props are flattened and shortened (no quote content).
 */

const EVENTS = new Set([
  "opened", "draft_resumed", "draft_discarded", "started",
  "voice_started", "voice_sent", "voice_cancelled", "voice_silent", "voice_failed",
  "file_picked", "file_failed",
  "ai_button", "suggestion_added", "undo", "new_quote",
  "item_added", "item_edited", "item_deleted", "item_moved", "mode_switched", "vat_converted",
  "photo_added", "photo_removed",
  "save_clicked", "save_failed", "review", "left",
  // guests (marketing site)
  "guest_cta", "guest_signup_opened", "guest_email_exists", "guest_saved", "guest_save_failed",
]);

export async function POST(req: NextRequest) {
  let body: { token?: string; session_id?: string; events?: { event?: string; props?: unknown }[] };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const v = verifyToken(body.token ?? "");
  const guest = !v.valid && !!verifyGuestToken(body.token ?? "");
  if (!v.valid && !guest) return Response.json({ ok: false }, { status: 401 });

  const events: TrackEvent[] = (Array.isArray(body.events) ? body.events : [])
    .slice(0, 20)
    .filter((e) => typeof e?.event === "string" && EVENTS.has(e.event))
    .map((e) => {
      const props = cleanProps(e.props);
      // The business's own name (from the signed token, not the page) — once per visit, so the views can show who it is.
      if (v.valid && e.event === "opened") props.company = (v.payload.company_name ?? "").slice(0, 60);
      if (guest) props.guest = true;
      return { event: e.event!, user_id: v.valid ? v.payload.user_id : GUEST_USER_ID, session_id: body.session_id, props };
    });
  if (events.length) after(() => track(...events));
  return Response.json({ ok: true });
}
