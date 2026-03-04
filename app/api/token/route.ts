import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

export async function GET(req: NextRequest) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return new Response(JSON.stringify({ error: "JWT_SECRET not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { searchParams } = new URL(req.url);
  const company  = searchParams.get("company")  ?? "חברת הדגמה";
  const user     = searchParams.get("user")     ?? undefined;
  const industry = searchParams.get("industry") ?? "שיפוצים";

  const payload = {
    company_name: company,
    user_name: user,
    industry,
    service_area: "ישראל",
  };

  const token = jwt.sign(payload, secret, { expiresIn: "7d" });

  return new Response(
    JSON.stringify({
      token,
      url: `/chat?token=${token}`,
      payload,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
