import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

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

  // Validate API key
  if (validApiKey && body.api_key !== validApiKey) {
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

  const expiresInSeconds = Math.round((body.expiresInHours ?? 24) * 3600);

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
