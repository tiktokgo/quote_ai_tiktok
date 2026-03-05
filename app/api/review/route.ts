import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { quote_id, user_id, stars, comment } = await req.json() as {
    quote_id?: string;
    user_id?: string;
    stars: number;
    comment?: string;
  };

  const url = process.env.REVIEW_WEBHOOK_URL;
  if (url) {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote_id, user_id, stars, comment }),
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
