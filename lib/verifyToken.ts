import jwt from "jsonwebtoken";

export interface AIContext {
  company_name: string;
  user_name?: string;
  service_area?: string;
  company_info?: string;
  company_logo?: string;
  industry: string;
  user_id?: string;
  email?: string;
  phone?: string;
  address?: string;
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
        user_name:    payload.user_name,
        service_area: payload.service_area,
        company_info: payload.company_info,
        company_logo: payload.company_logo,
        industry:     payload.industry,
        user_id:      payload.user_id,
        email:        payload.email,
        phone:        payload.phone,
        address:      payload.address,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `Token error: ${msg}` };
  }
}
