import { NextRequest } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function extractMeta(html: string, property: string): string {
  const m =
    html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i")) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i")) ||
    html.match(new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, "i")) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, "i"));
  return m?.[1]?.trim() ?? "";
}

function extractLink(html: string, rel: string): string {
  const m = html.match(new RegExp(`<link[^>]+rel=["'][^"']*${rel}[^"']*["'][^>]+href=["']([^"']+)["']`, "i")) ||
            html.match(new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*${rel}[^"']*["']`, "i"));
  return m?.[1]?.trim() ?? "";
}

function extractTitle(html: string): string {
  return html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "";
}

function extractJsonLd(html: string): Record<string, unknown> {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const s of scripts) {
    try {
      const parsed = JSON.parse(s[1]);
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (obj && (obj["@type"] === "Organization" || obj["@type"] === "LocalBusiness" || obj.name)) {
        return obj as Record<string, unknown>;
      }
    } catch { /* ignore */ }
  }
  return {};
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
}

function resolveUrl(base: string, path: string): string {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  if (path.startsWith("//")) return "https:" + path;
  try {
    return new URL(path, base).href;
  } catch {
    return "";
  }
}

export async function POST(req: NextRequest) {
  let url: string;
  try {
    ({ url } = await req.json());
  } catch {
    return Response.json({ ok: false, message: "Invalid request" }, { status: 400 });
  }

  if (!url) return Response.json({ ok: false, message: "Missing url" }, { status: 400 });

  // Normalize URL
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  let html: string;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; QuoteAI/1.0; +https://quote-ai-tiktok.vercel.app)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "he,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });
    html = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[scan-website] fetch failed:", msg);
    return Response.json({ ok: false, message: "לא הצלחנו לגשת לאתר" });
  }

  // Extract signals from HTML
  const ogImage     = extractMeta(html, "og:image");
  const ogSiteName  = extractMeta(html, "og:site_name");
  const themeColor  = extractMeta(html, "theme-color");
  const touchIcon   = extractLink(html, "apple-touch-icon") || extractLink(html, "icon");
  const title       = extractTitle(html);
  const jsonLd      = extractJsonLd(html);
  const text        = visibleText(html);

  // Resolve logo URL relative to base
  const logo_url = resolveUrl(url, ogImage || touchIcon) || "";
  const theme_color = themeColor || "";

  // Build a structured hint for the AI
  const hints: Record<string, string> = {};
  if (ogSiteName) hints.site_name = ogSiteName;
  if (title)      hints.title = title;
  if (jsonLd.name)        hints.ld_name    = String(jsonLd.name);
  if (jsonLd.email)       hints.ld_email   = String(jsonLd.email);
  if (jsonLd.description) hints.ld_desc    = String(jsonLd.description);
  const addr = jsonLd.address as Record<string, string> | undefined;
  if (addr) {
    hints.ld_address = [addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ");
  }

  // AI extraction
  const systemMsg = `You are an assistant that extracts business information from website content.
Return ONLY a valid JSON object with these keys:
- company_name: string (the business name, in the original language)
- industry: string (e.g. "אינסטלציה", "ניהול קמפיינים", "עריכת דין" — in Hebrew if possible)
- email: string (first contact email found, or "")
- address: string (full address if found, or "")
Be concise. Do not invent data that's not in the content.`;

  const userMsg = `Website URL: ${url}
Structured hints: ${JSON.stringify(hints)}
Page text sample: ${text}`;

  let company_name = "", industry = "", email = "", address = "";
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemMsg },
        { role: "user",   content: userMsg },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
    });
    const parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
    company_name = parsed.company_name ?? "";
    industry     = parsed.industry     ?? "";
    email        = parsed.email        ?? "";
    address      = parsed.address      ?? "";
  } catch (e) {
    console.warn("[scan-website] AI extraction failed:", e);
  }

  console.log(`[scan-website] url:${url} name:${company_name} industry:${industry} logo:${logo_url}`);

  return Response.json({ ok: true, logo_url, theme_color, company_name, industry, email, address });
}
