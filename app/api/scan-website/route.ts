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
  const m =
    html.match(new RegExp(`<link[^>]+rel=["'][^"']*${rel}[^"']*["'][^>]+href=["']([^"']+)["']`, "i")) ||
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
  try { return new URL(path, base).href; } catch { return ""; }
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

  let domain = "";
  try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }

  // ── Always-available logo via Google Favicon service ──────────────────────
  const google_favicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : "";

  // ── Try fetching the site HTML ─────────────────────────────────────────────
  let html = "";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(7000),
    });
    if (res.ok) html = await res.text();
    console.log(`[scan-website] fetch ${url} → HTTP ${res.status}, html length: ${html.length}`);
  } catch (err) {
    console.warn("[scan-website] fetch failed:", err instanceof Error ? err.message : err);
    // Continue — we can still use domain-based extraction
  }

  // ── Extract from HTML (works even for mostly-empty JS-rendered pages) ──────
  const ogImage    = extractMeta(html, "og:image");
  const ogSiteName = extractMeta(html, "og:site_name");
  const themeColor = extractMeta(html, "theme-color");
  const touchIcon  = extractLink(html, "apple-touch-icon") || extractLink(html, "icon");
  const title      = extractTitle(html);
  const jsonLd     = extractJsonLd(html);
  const text       = visibleText(html);

  // Logo: prefer og:image > touch icon > Google favicon
  const logo_url = resolveUrl(url, ogImage || touchIcon) || google_favicon;
  const theme_color = themeColor || "";

  // Hints for AI
  const hints: Record<string, string> = { domain };
  if (ogSiteName) hints.site_name = ogSiteName;
  if (title)      hints.title = title;
  if (jsonLd.name)        hints.ld_name    = String(jsonLd.name);
  if (jsonLd.email)       hints.ld_email   = String(jsonLd.email);
  if (jsonLd.description) hints.ld_desc    = String(jsonLd.description);
  const addr = jsonLd.address as Record<string, string> | undefined;
  if (addr) hints.ld_address = [addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ");

  console.log(`[scan-website] hints: ${JSON.stringify(hints)}, text length: ${text.length}`);

  // ── AI extraction — works even from domain name alone ──────────────────────
  const systemMsg = `You are an assistant that extracts Israeli business information from a website domain and any available content.
Return ONLY a valid JSON object with these exact keys (use "" if unknown):
- company_name: string — business name in the original language (often Hebrew). Infer from domain if needed (e.g. "kahn-shfutsim.co.il" → "כהן שיפוצים").
- industry: string — business category in Hebrew (e.g. "אינסטלציה", "שיפוצים", "עריכת דין", "ניהול קמפיינים", "מכירת ציוד"). Infer from domain/title/text.
- email: string — first contact email found, or "".
- address: string — full address if found, or "".
Always try to infer company_name and industry even from the domain name alone.`;

  const userMsg = `URL: ${url}
Available hints: ${JSON.stringify(hints)}
Page text (may be empty if JS-rendered): ${text || "(empty — JS-rendered site)"}`;

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
    const raw = completion.choices[0].message.content ?? "{}";
    console.log("[scan-website] AI raw:", raw);
    const parsed = JSON.parse(raw);
    company_name = parsed.company_name ?? "";
    industry     = parsed.industry     ?? "";
    email        = parsed.email        ?? "";
    address      = parsed.address      ?? "";
  } catch (e) {
    console.warn("[scan-website] AI extraction failed:", e);
  }

  console.log(`[scan-website] result → name:"${company_name}" industry:"${industry}" logo:"${logo_url}"`);

  return Response.json({ ok: true, logo_url, theme_color, company_name, industry, email, address });
}
