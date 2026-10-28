/**
 * WhatsApp voice notes reach us as a public link to ManyChat's S3 bucket
 * (manybot-files.s3.<region>.amazonaws.com/.../original_….ogg — tested 2026-10-28).
 * Only that host is fetched, so the endpoint can't be used to fetch arbitrary URLs.
 */

const ALLOWED_HOST = /^manybot-files\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/;
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

export function isVoiceUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === "https:" && ALLOWED_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

export async function downloadVoice(url: string): Promise<File> {
  if (!isVoiceUrl(url)) throw new Error("audio host not allowed");
  const res = await fetch(url.trim(), { redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`audio HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_AUDIO_BYTES) throw new Error("audio too long");
  const ext = (new URL(url).pathname.match(/\.(ogg|oga|mp3|m4a|mp4|wav|webm|opus)$/i)?.[1] ?? "ogg").toLowerCase();
  // gpt-4o-transcribe reads opus as ogg
  const name = ext === "opus" ? "voice.ogg" : `voice.${ext}`;
  return new File([buf], name, { type: res.headers.get("content-type") || "audio/ogg" });
}
