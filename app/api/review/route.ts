import { NextResponse } from "next/server";
import { userIdFromRequest } from "@/lib/auth";

export async function POST(req: Request) {
  const { quote_id, stars, comment } = await req.json() as {
    quote_id?: string;
    stars: number;
    comment?: string;
  };
  // user_id only from a valid JWT (guests have none)
  const auth = userIdFromRequest(req);
  const user_id = auth.ok ? auth.userId : undefined;

  const url = process.env.REVIEW_WEBHOOK_URL;
  const key = process.env.BUBBLE_API_KEY;
  console.log(`[review] quote_id:${quote_id} user_id:${user_id} stars:${stars} comment:${comment} url_set:${!!url}`);
  if (url) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ quote_id, user_id, stars, comment }),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text().catch(() => "");
      console.log(`[review] webhook HTTP ${res.status} response:${text.slice(0, 100)}`);
    } catch (e) {
      console.warn("[review] webhook error:", e instanceof Error ? e.message : e);
    }
  }

  return NextResponse.json({ ok: true });
}
