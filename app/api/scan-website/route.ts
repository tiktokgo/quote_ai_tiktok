import { NextRequest } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
};

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

function resolveUrl(base: string, path: string): string {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  if (path.startsWith("//")) return "https:" + path;
  try { return new URL(path, base).href; } catch { return ""; }
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#64;/g, "@")
    .replace(/&#x40;/gi, "@")
    .replace(/&#46;/g, ".")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function findEmail(html: string): string {
  const decoded = decodeHtmlEntities(html);
  // 1. mailto: links — most deliberate mention
  const mailto = decoded.match(/mailto:([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/i);
  if (mailto) return mailto[1];
  // 2. Plain email in regular HTML
  const plain = decoded.match(/\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/);
  if (plain && !/noreply|no-reply|privacy|sentry|@example/i.test(plain[1])) return plain[1];
  return "";
}

function findPhone(html: string): string {
  // 1. tel: links — most reliable
  const tel = html.match(/href=["']tel:([\d+\-\s()]{7,})/i);
  if (tel) return tel[1].trim();
  // 2. Israeli phone patterns:
  //    Fixed line: 0X-XXXXXXX  (e.g. 03-9090299, 09-1234567)
  //    Mobile:     05X-XXXXXXX (e.g. 052-1234567, 054-9876543)
  //    Intl:       +972-X-XXXXXXX / +972-5X-XXXXXXX
  const plain = html.match(/(?:\+972[-\s]?|0)(?:5[0-9][-\s]?\d{7}|[23489][-\s]?\d{7})/);
  if (plain) return plain[0].trim();
  return "";
}

function rgbToHex(r: string, g: string, b: string): string {
  return "#" + [r, g, b].map((n) => parseInt(n).toString(16).padStart(2, "0")).join("");
}

// Extract brand colors from combined HTML (CSS vars, theme-color, inline styles)
function extractBrandColors(html: string): [string, string] {
  const isHex = (v: string) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
  const addColor = (hex: string) => { if (isHex(hex) && !found.includes(hex.toLowerCase())) found.push(hex.toLowerCase()); };
  const found: string[] = [];

  // 1. CSS variables from <style> blocks — supports hex, rgb(), and space-separated (Tailwind)
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join("\n");
  const cssVarNames = [
    "--primary", "--brand", "--main-color", "--color-primary",
    "--accent", "--secondary", "--highlight", "--color-secondary",
    "--color-accent", "--primary-color", "--brand-color",
    "--clr-primary", "--clr-accent", "--theme-primary", "--theme-color",
  ];
  for (const varName of cssVarNames) {
    if (found.length >= 2) break;
    // hex
    const mHex = styleBlocks.match(new RegExp(`${varName}\\s*:\\s*(#[0-9a-fA-F]{3,8})`, "i"));
    if (mHex) { addColor(mHex[1]); continue; }
    // rgb(r, g, b)
    const mRgb = styleBlocks.match(new RegExp(`${varName}\\s*:\\s*rgb\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)`, "i"));
    if (mRgb) { addColor(rgbToHex(mRgb[1], mRgb[2], mRgb[3])); continue; }
    // Tailwind: --color: 59 130 246
    const mSpace = styleBlocks.match(new RegExp(`${varName}\\s*:\\s*(\\d{1,3})\\s+(\\d{1,3})\\s+(\\d{1,3})\\s*[;}]`, "i"));
    if (mSpace && parseInt(mSpace[1]) <= 255 && parseInt(mSpace[2]) <= 255 && parseInt(mSpace[3]) <= 255) {
      addColor(rgbToHex(mSpace[1], mSpace[2], mSpace[3]));
    }
  }

  // 2. theme-color meta tag
  if (found.length < 2) {
    const tm =
      html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,8})["']/i) ||
      html.match(/<meta[^>]+content=["'](#[0-9a-fA-F]{3,8})["'][^>]+name=["']theme-color["']/i);
    if (tm) addColor(tm[1]);
  }

  // 3. background-color / color on header, nav, footer, body inline styles or common class patterns
  if (found.length < 2) {
    // hex in inline styles on key elements
    const inlineHex = [
      ...html.matchAll(/<(?:header|nav|footer|body)[^>]+style=["'][^"']*(?:background(?:-color)?|color)\s*:\s*(#[0-9a-fA-F]{3,8})/gi),
    ];
    for (const m of inlineHex) {
      addColor(m[1]);
      if (found.length >= 2) break;
    }
  }

  // 4. Any hex color that appears many times in <style> (dominant color heuristic)
  if (found.length < 1) {
    const allHex = [...styleBlocks.matchAll(/#([0-9a-fA-F]{6})\b/g)].map((m) => "#" + m[1].toLowerCase());
    const freq: Record<string, number> = {};
    for (const h of allHex) freq[h] = (freq[h] || 0) + 1;
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    // Skip near-white and near-black
    for (const [hex] of sorted) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      if (brightness > 30 && brightness < 220) { addColor(hex); if (found.length >= 2) break; }
    }
  }

  return [found[0] || "#7c3aed", found[1] || "#a855f7"];
}

async function fetchHtml(url: string, timeout = 3000): Promise<string> {
  return fetch(url, { headers: FETCH_HEADERS, redirect: "follow", signal: AbortSignal.timeout(timeout) })
    .then((r) => r.text())
    // Keep head (styles, meta) + large tail (footer has email/phone/colors)
    .then((t) => t.length > 50000 ? t.slice(0, 15000) + "\n" + t.slice(-35000) : t)
    .catch(() => "");
}

export async function POST(req: NextRequest) {
  let url: string;
  try {
    ({ url } = await req.json());
  } catch {
    return Response.json({ ok: false, message: "Invalid request" }, { status: 400 });
  }

  if (!url) return Response.json({ ok: false, message: "Missing url" }, { status: 400 });

  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  let domain = "";
  try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }

  // Always-available logo via Google Favicon
  const google_favicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : "";

  // ── Fetch homepage + 3 secondary pages IN PARALLEL ──────────────────────
  const origin = url.replace(/\/$/, "");
  const [html, contactHtml, aboutHtml] = await Promise.all([
    fetchHtml(url, 3000),
    fetchHtml(`${origin}/contact`, 2500)
      .then((h) => h || fetchHtml(`${origin}/contact-us`, 2000))
      .catch(() => ""),
    fetchHtml(`${origin}/about`, 2000)
      .then((h) => h || fetchHtml(`${origin}/about-us`, 2000))
      .catch(() => ""),
  ]);

  const combinedHtml = html + "\n" + contactHtml + "\n" + aboutHtml;

  const ogImage    = extractMeta(html, "og:image");
  const ogSiteName = extractMeta(html, "og:site_name");
  const touchIcon  = extractLink(html, "apple-touch-icon") || extractLink(html, "icon");
  const title      = extractTitle(html);
  const jsonLd     = extractJsonLd(html);

  // Try to find actual logo from HTML — look for img tags with logo-related attributes
  function findLogoInHtml(h: string): string {
    // JSON-LD logo
    if (jsonLd.logo) {
      const ldLogo = typeof jsonLd.logo === "string" ? jsonLd.logo : (jsonLd.logo as Record<string, string>)?.url;
      if (ldLogo) return ldLogo;
    }
    // <img> with class/id/alt containing "logo"
    const logoImgMatch = h.match(/<img[^>]*(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i)
      || h.match(/<img[^>]*src=["']([^"']+)["'][^>]*(?:class|id|alt)=["'][^"']*logo[^"']*["']/i);
    if (logoImgMatch?.[1]) return logoImgMatch[1];
    // <a> wrapping <img> in header/nav
    const headerLogoMatch = h.match(/<(?:header|nav)[^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<\/(?:header|nav)>/i);
    if (headerLogoMatch?.[1]) return headerLogoMatch[1];
    return "";
  }

  const htmlLogo = findLogoInHtml(html);
  // Priority: JSON-LD logo > HTML logo img > apple-touch-icon > Google favicon
  // Intentionally skip og:image — it's usually a social banner, not the logo
  const logo_url = resolveUrl(url, htmlLogo || touchIcon) || google_favicon;

  // Extract brand colors from all fetched pages
  const [color1, color2] = extractBrandColors(combinedHtml);

  // Build hints — everything we have
  const hints: Record<string, string> = { domain };
  if (ogSiteName)   hints.og_site_name = ogSiteName;
  if (title)        hints.page_title   = title;
  if (jsonLd.name)  hints.ld_name      = String(jsonLd.name);
  if (jsonLd.email) hints.ld_email     = String(jsonLd.email);
  const addr = jsonLd.address as Record<string, string> | undefined;
  if (addr) hints.ld_address = [addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ");

  // Search for email across all fetched pages
  const foundEmail = findEmail(combinedHtml);
  if (foundEmail) hints.found_email = foundEmail;
  const foundPhone = findPhone(combinedHtml);
  if (foundPhone) hints.found_phone = foundPhone;

  console.log(`[scan-website] domain:${domain} hints:${JSON.stringify(hints)} colors:[${color1},${color2}]`);

  // ── AI extraction ──────────────────────────────────────────────────────────
  let company_name = "", industry = "", email = "", address = "", phone = "";
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You extract Israeli business info from a website domain and hints.
Return a JSON object with exactly these keys:
- company_name: the business name. MUST infer from domain if not explicit (e.g. "cohen-plumbing.co.il" → "כהן אינסטלציה", "studio-design.com" → "Studio Design"). Never return empty.
- industry: business category in Hebrew (e.g. "אינסטלציה", "שיפוצים", "עיצוב גרפי", "עריכת דין", "שיווק דיגיטלי"). Infer from domain/title. Never return empty.
- email: If hints contain "found_email" or "ld_email", you MUST return that value exactly. Otherwise return "".
- address: physical address if found in hints, else "".`,
        },
        {
          role: "user",
          content: `Domain and hints: ${JSON.stringify(hints)}`,
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 200,
      temperature: 0,
    });
    const raw = completion.choices[0].message.content ?? "{}";
    console.log("[scan-website] AI:", raw);
    const parsed = JSON.parse(raw);
    company_name = String(parsed.company_name ?? "").trim();
    industry     = String(parsed.industry     ?? "").trim();
    email        = String(parsed.email        ?? "").trim();
    address      = String(parsed.address      ?? "").trim();
    if (email === '""' || email === "null") email = "";
    if (address === '""' || address === "null") address = "";
    // Phone — AI doesn't extract it; use found_phone from HTML directly
    if (hints.found_phone) phone = hints.found_phone;
    // Always use found_email if AI didn't extract one
    if (!email && hints.found_email) email = hints.found_email;
  } catch (e) {
    console.warn("[scan-website] AI failed:", e instanceof Error ? e.message : e);
    company_name = domain.split(".")[0].replace(/[-_]/g, " ");
    if (hints.found_email) email = hints.found_email;
    if (hints.found_phone) phone = hints.found_phone;
  }

  console.log(`[scan-website] → name:"${company_name}" industry:"${industry}" email:"${email}" color1:"${color1}" color2:"${color2}"`);

  return Response.json({ ok: true, logo_url, company_name, industry, email, address, phone, color1, color2 });
}
