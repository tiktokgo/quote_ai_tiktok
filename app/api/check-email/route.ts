import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const checkUrl = process.env.EMAIL_CHECK_URL;
  const key = process.env.BUBBLE_API_KEY;

  // If not configured, always treat as new user — never block
  if (!checkUrl) {
    return Response.json({ exists: false });
  }

  let email: string;
  try {
    ({ email } = await req.json());
  } catch {
    return Response.json({ exists: false }, { status: 400 });
  }

  if (!email) return Response.json({ exists: false });

  try {
    const res = await fetch(checkUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(5000),
    });

    const text = await res.text().catch(() => "");
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* ignore */ }

    // Bubble wraps return data in a "response" key: { status, response: { exists } }
    const r = (data.response ?? {}) as Record<string, unknown>;
    const exists =
      data.exists === true  || r.exists === true  ||
      data.found  === true  || r.found  === true  ||
      data.new    === false || r.new    === false  ||
      data.is_new === false || r.is_new === false  ||
      data.exist  === "yes" || r.exist  === "yes"  ||
      data.exist  === true  || r.exist  === true   ||
      res.status  === 409;

    console.log(`[check-email] email:${email} status:${res.status} exists:${exists} response:${text.slice(0, 100)}`);
    return Response.json({ exists });
  } catch (e) {
    // On any error (timeout, network) — never block the user
    console.warn("[check-email] error:", e instanceof Error ? e.message : e);
    return Response.json({ exists: false });
  }
}
