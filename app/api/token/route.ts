import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import { safeEqual } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const jwtSecret  = process.env.JWT_SECRET;
  const validApiKey = process.env.TOKEN_API_KEY;

  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "JWT_SECRET not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: {
    api_key?: string;
    industry?: string;
    company_name?: string;
    user_name?: string;
    company_info?: string;
    company_logo?: string;
    user_id?: string;
    expiresInHours?: number;
    email?: string;
    phone?: string;
    address?: string;
  };

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate API key — fail closed: without TOKEN_API_KEY anyone could mint
  // a JWT for any user_id (and use the chat on our OpenAI account)
  if (!validApiKey) {
    console.error("TOKEN_API_KEY not set — refusing to issue tokens");
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (typeof body.api_key !== "string" || !safeEqual(body.api_key, validApiKey)) {
    return new Response(JSON.stringify({ error: "Invalid api_key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.company_name || !body.industry) {
    return new Response(JSON.stringify({ error: "company_name and industry are required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // At most 30 days
  const hours = Math.min(Math.max(Number(body.expiresInHours ?? 24) || 24, 0.1), 720);
  const expiresInSeconds = Math.round(hours * 3600);

  const payload = {
    company_name: body.company_name,
    industry:     body.industry,
    user_name:    body.user_name,
    company_info: body.company_info,
    company_logo: body.company_logo,
    user_id:      body.user_id,
    email:        body.email,
    phone:        body.phone,
    address:      body.address,
  };

  const token = jwt.sign(payload, jwtSecret, { expiresIn: expiresInSeconds });

  const chatUrl = body.user_id
    ? `/chat?token=${token}&user_id=${encodeURIComponent(body.user_id)}`
    : `/chat?token=${token}`;

  return new Response(
    JSON.stringify({ token, url: chatUrl }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
