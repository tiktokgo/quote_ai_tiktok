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

  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  let domain = "";
  try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }

  // Always-available logo via Google Favicon
  const google_favicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : "";

  // ── Fetch HTML and run AI extraction IN PARALLEL ───────────────────────────
  const htmlPromise = fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(3000), // short timeout — only need meta tags from <head>
  })
    .then((r) => r.text())
    .then((t) => t.slice(0, 15000)) // only need the <head> section
    .catch((e) => { console.warn("[scan-website] HTML fetch:", e instanceof Error ? e.message : e); return ""; });

  // Run AI with just the domain immediately (fast path), then enhance with HTML
  const html = await htmlPromise;

  const ogImage    = extractMeta(html, "og:image");
  const ogSiteName = extractMeta(html, "og:site_name");
  const themeColor = extractMeta(html, "theme-color");
  const touchIcon  = extractLink(html, "apple-touch-icon") || extractLink(html, "icon");
  const title      = extractTitle(html);
  const jsonLd     = extractJsonLd(html);

  const logo_url    = resolveUrl(url, ogImage || touchIcon) || google_favicon;
  const theme_color = themeColor || "";

  // Build hints — everything we have
  const hints: Record<string, string> = { domain };
  if (ogSiteName)       hints.og_site_name = ogSiteName;
  if (title)            hints.page_title   = title;
  if (jsonLd.name)      hints.ld_name      = String(jsonLd.name);
  if (jsonLd.email)     hints.ld_email     = String(jsonLd.email);
  const addr = jsonLd.address as Record<string, string> | undefined;
  if (addr) hints.ld_address = [addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ");

  const emailMatch = html.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/);
  if (emailMatch) hints.found_email = emailMatch[0];

  console.log(`[scan-website] domain:${domain} hints:${JSON.stringify(hints)}`);

  // ── AI extraction ──────────────────────────────────────────────────────────
  let company_name = "", industry = "", email = "", address = "";
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
- email: contact email if found in hints, else "".
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
    // Reject placeholder-like values
    if (email === '""' || email === "null") email = "";
    if (address === '""' || address === "null") address = "";
    // Use found_email from HTML if AI didn't extract one
    if (!email && hints.found_email) email = hints.found_email;
  } catch (e) {
    console.warn("[scan-website] AI failed:", e instanceof Error ? e.message : e);
    // Fallback: derive company name from domain
    company_name = domain.split(".")[0].replace(/[-_]/g, " ");
  }

  console.log(`[scan-website] → name:"${company_name}" industry:"${industry}" email:"${email}" logo:"${logo_url}"`);

  return Response.json({ ok: true, logo_url, theme_color, company_name, industry, email, address });
}
