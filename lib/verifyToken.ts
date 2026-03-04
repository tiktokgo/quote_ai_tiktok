import jwt from "jsonwebtoken";

export interface AIContext {
  company_name: string;
  user_name?: string;
  service_area?: string;
  company_info?: string;
  industry: string;
}

interface TokenPayload extends AIContext {
  iat?: number;
  exp?: number;
}

export function verifyToken(
  token: string
): { valid: true; payload: AIContext } | { valid: false; reason: string } {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return { valid: false, reason: "JWT_SECRET not configured" };
  }
  if (!token) {
    return { valid: false, reason: "Missing token" };
  }
  try {
    const payload = jwt.verify(token, secret) as TokenPayload;
    if (!payload.company_name) {
      return { valid: false, reason: "Token missing company_name" };
    }
    if (!payload.industry) {
      return { valid: false, reason: "Token missing industry" };
    }
    return {
      valid: true,
      payload: {
        company_name: payload.company_name,
        user_name: payload.user_name,
        service_area: payload.service_area,
        company_info: payload.company_info,
        industry: payload.industry,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `Token error: ${msg}` };
  }
}
