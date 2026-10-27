import { NextRequest, after } from "next/server";
import { verifyToken } from "@/lib/verifyToken";
import { track, cleanProps, type TrackEvent } from "@/lib/v2/track";

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
]);

export async function POST(req: NextRequest) {
  let body: { token?: string; session_id?: string; events?: { event?: string; props?: unknown }[] };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const v = verifyToken(body.token ?? "");
  if (!v.valid) return Response.json({ ok: false }, { status: 401 });

  const events: TrackEvent[] = (Array.isArray(body.events) ? body.events : [])
    .slice(0, 20)
    .filter((e) => typeof e?.event === "string" && EVENTS.has(e.event))
    .map((e) => ({ event: e.event!, user_id: v.payload.user_id, session_id: body.session_id, props: cleanProps(e.props) }));
  if (events.length) after(() => track(...events));
  return Response.json({ ok: true });
}
