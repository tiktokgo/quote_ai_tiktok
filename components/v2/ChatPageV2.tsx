"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { AIContext } from "@/lib/verifyToken";
import {
  UNITS, DEFAULT_UNIT, computeTotals, lineTotal, mergeQuoteV2, switchMode, normalizeItem,
  formatILS, formatQty,
} from "@/lib/v2/quote";
import type { QuoteV2, QuoteItemV2, QuoteUpdateV2, PricingMode } from "@/lib/v2/quote";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** What the bubble shows when it differs from what the AI gets (e.g. an uploaded file). */
  display?: string;
  loading?: boolean;
  error?: boolean;
}

type Q = Partial<QuoteV2>;
type SaveState = "idle" | "saving" | "saved" | "error";
type Voice = "idle" | "recording" | "transcribing";

interface Props {
  aiContext: AIContext;
  token: string;
  bubbleEnv: "test" | "live";
}

const PURPLE = "#7c3aed";
const PURPLE_2 = "#a855f7";
const PURPLE_LIGHT = "#7c3aed26";
const FLASH_BG = "#dcfce7";
const MISSING_BG = "#fef3c7";

type Suggestion = { name: string; description?: string };
type AiSuggest = (kind: "item" | "notes" | "terms" | "photo", index?: number, imageUrl?: string) => Promise<unknown[]>;
const MAX_PHOTOS = 10;

// ── Draft persistence (survives a refresh of the Bubble iframe) ───────────────
const draftKey = (userId?: string) => `quote_v2_draft:${userId ?? "anon"}`;
interface Draft { messages: ChatMessage[]; quote: Q; at: number }
function loadDraft(userId?: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(userId));
    if (!raw) return null;
    const d = JSON.parse(raw) as { messages: ChatMessage[]; quote: Q; at: number };
    if (Date.now() - d.at > 3 * 24 * 3600 * 1000) return null; // older than 3 days
    return { messages: d.messages.filter((m) => !m.loading), quote: d.quote, at: d.at };
  } catch {
    return null;
  }
}
function saveDraft(userId: string | undefined, messages: ChatMessage[], quote: Q) {
  try {
    localStorage.setItem(draftKey(userId), JSON.stringify({ messages: messages.filter((m) => !m.loading), quote, at: Date.now() }));
  } catch { /* storage blocked — ignore */ }
}
function clearDraft(userId?: string) {
  try { localStorage.removeItem(draftKey(userId)); } catch { /* ignore */ }
}

const buzz = (ms: number | number[]) => { try { navigator.vibrate?.(ms); } catch { /* iOS: not supported */ } };
const timeAgo = (at: number) => {
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 60) return min <= 1 ? "לפני דקה" : `לפני ${min} דקות`;
  const h = Math.round(min / 60);
  return h < 24 ? (h === 1 ? "לפני שעה" : `לפני ${h} שעות`) : h < 48 ? "אתמול" : `לפני ${Math.round(h / 24)} ימים`;
};
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/** Phone photos are often 3–8MB; resize to fit the 4MB request limit and keep the text readable. */
async function shrinkImage(file: File): Promise<File> {
  const webSafe = ["image/jpeg", "image/png", "image/webp"].includes(file.type);
  if (!file.type.startsWith("image/") || (webSafe && file.size < 1.5 * 1024 * 1024)) return file; // else re-encode (also HEIC → JPEG)
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

const FILE_ERRORS: Record<string, string> = {
  scanned_pdf: "ה-PDF סרוק ואין בו טקסט — צלם אותו ושלח כתמונה",
  not_a_quote: "לא מצאתי בקובץ פרטים להצעת מחיר",
  too_large: "הקובץ גדול מדי (עד 4MB)",
  unsupported_type: "אפשר להעלות PDF או תמונה",
};

// ── Main component ────────────────────────────────────────────────────────────
export default function ChatPageV2({ aiContext, token, bubbleEnv }: Props) {
  const greeting = `${aiContext.user_name ? `שלום ${aiContext.user_name}! ` : ""}ספר לי על העבודה — מה עושים, למי, וכמה זה עולה (סכום אחד או מחיר לכל פריט). אפשר גם בקול 🎙`;

  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: greeting }]);
  const [quote, setQuote] = useState<Q>({});
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [restored, setRestored] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null); // offered on the start screen, not auto-opened
  const [confirmNew, setConfirmNew] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [flash, setFlash] = useState<number[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [undo, setUndo] = useState<Q | null>(null);

  const [isMobile, setIsMobile] = useState(false);
  const [chatOpen, setChatOpen] = useState(false); // mobile: full conversation over the quote

  const messagesRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [voice, setVoice] = useState<Voice>("idle");
  const [recSeconds, setRecSeconds] = useState(0);
  const levelRef = useRef(0);          // live mic level 0..1 — read by the voice bars, no re-render
  const cancelledRef = useRef(false);  // 🗑 while recording: stop without transcribing

  // A saved draft is offered on the start screen ("continue" / "start new") — never opened by itself.
  useEffect(() => {
    const d = loadDraft(aiContext.user_id);
    if (d && (d.quote.items?.length || d.quote.title)) setPendingDraft(d);
    setIsMobile(window.innerWidth < 768);
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist on every change
  useEffect(() => {
    if (quote.items?.length || quote.title) saveDraft(aiContext.user_id, messages, quote);
  }, [messages, quote, aiContext.user_id]);

  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages, chatOpen]);

  const hasQuote = (quote.items?.length ?? 0) > 0 || !!quote.title;
  const started = hasQuote || messages.some((m) => m.role === "user");

  // ── Send to AI ──────────────────────────────────────────────────────────────
  const send = useCallback(async (text: string, display?: string) => {
    const userText = text.trim();
    if (!userText || isLoading) return;
    const history = [...messages.filter((m) => !m.loading && !m.error), { role: "user" as const, content: userText, display }];
    setMessages([...history, { role: "assistant", content: "", loading: true }]);
    setIsLoading(true);
    try {
      const res = await fetch("/api/v2/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, currentQuote: quote, messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      const data = (await res.json().catch(() => ({}))) as { text?: string; quote?: QuoteUpdateV2 | null; error?: string };
      if (!res.ok || !data.text) throw new Error(data.error ?? `HTTP ${res.status}`);

      if (data.quote) {
        const next = mergeQuoteV2(quote, data.quote);
        // Flash the rows that are new or changed, so the user sees what the AI touched.
        const before = quote.items ?? [];
        const changed = (next.items ?? [])
          .map((it, i) => (JSON.stringify(it) !== JSON.stringify(before[i]) ? i : -1))
          .filter((i) => i >= 0);
        setUndo(quote); // one tap brings back the quote as it was before this AI change
        setQuote(next);
        if (data.quote.suggested_items?.length) {
          const have = new Set((next.items ?? []).map((it) => it.name.trim()));
          setSuggestions(data.quote.suggested_items.filter((s) => s?.name?.trim() && !have.has(s.name.trim())).slice(0, 6));
        }
        if (changed.length && before.length) {
          setFlash(changed);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash([]), 2200);
        }
        setChatOpen(false); // mobile: show the quote that just changed
        buzz([30, 50, 30]);
      }
      setMessages([...history, { role: "assistant", content: data.text }]);
    } catch {
      setMessages([...history, { role: "assistant", content: "משהו השתבש — נסה לשלוח שוב.", error: true }]);
      setInput(userText);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, messages, quote, token]);

  const handleSend = useCallback(() => {
    const t = input;
    setInput("");
    send(t);
  }, [input, send]);

  const addError = useCallback((content: string) =>
    setMessages((prev) => [...prev, { role: "assistant", content, error: true }]), []);

  // ── Voice: record (MediaRecorder) → /api/v2/transcribe → send as a message ──
  // Same approach as the Bubble voice_test page, which worked on desktop, mobile and the app.
  const MAX_REC_SEC = 180;
  const SILENCE_RMS = 0.015; // room noise is ~0.002–0.008; normal speech peaks well above 0.05
  const handleVoice = useCallback(async () => {
    if (voice === "transcribing" || isLoading) return;
    if (voice === "recording") { recorderRef.current?.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      addError("ההקלטה לא נתמכת בדפדפן הזה — אפשר להקליד");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      addError("אין גישה למיקרופון — צריך לאשר הרשאה.");
      return;
    }
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    const type = types.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
    const rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    const used = rec.mimeType || type || "audio/mp4";
    const chunks: Blob[] = [];
    // Level meter: a silent recording must not reach the transcriber — on silence it
    // invents plausible text ("אילן 054…, רחוב הברזל") instead of returning nothing.
    let peak = 0;
    let meter: { ctx: AudioContext; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;
    try {
      const ctx = new AudioContext();
      void ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      meter = { ctx, analyser, buf: new Float32Array(analyser.fftSize) };
    } catch { /* no Web Audio — skip the silence check */ }
    const sampleLevel = () => {
      if (!meter) return;
      meter.analyser.getFloatTimeDomainData(meter.buf);
      let sum = 0;
      for (const v of meter.buf) sum += v * v;
      const rms = Math.sqrt(sum / meter.buf.length);
      peak = Math.max(peak, rms);
      levelRef.current = Math.sqrt(Math.min(1, Math.max(0, rms - 0.01) / 0.12));
    };
    let raf = 0;
    const meterLoop = () => { sampleLevel(); raf = requestAnimationFrame(meterLoop); };
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      if (timerRef.current) clearInterval(timerRef.current);
      cancelAnimationFrame(raf);
      levelRef.current = 0;
      stream.getTracks().forEach((t) => t.stop());
      const measured = !!meter && meter.ctx.state === "running";
      meter?.ctx.close().catch(() => {});
      buzz(30);
      if (cancelledRef.current) { cancelledRef.current = false; setVoice("idle"); return; }
      const blob = new Blob(chunks, { type: used });
      if (blob.size < 1000) { setVoice("idle"); return; }
      if (measured && peak < SILENCE_RMS) {
        setVoice("idle");
        addError("לא שמעתי דיבור בהקלטה — נסה שוב, קרוב יותר למיקרופון");
        return;
      }
      setVoice("transcribing");
      try {
        const ext = used.includes("mp4") ? "mp4" : used.includes("ogg") ? "ogg" : "webm";
        const fd = new FormData();
        fd.append("audio", blob, `recording.${ext}`);
        const res = await fetch("/api/v2/transcribe", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
        const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok || !data.text) throw new Error(data.error ?? `HTTP ${res.status}`);
        setVoice("idle");
        send(data.text);
      } catch (e) {
        setVoice("idle");
        addError(e instanceof Error && e.message === "no_speech" ? "לא שמעתי דיבור בהקלטה — נסה שוב" : "התמלול נכשל — נסה שוב או הקלד");
      }
    };
    recorderRef.current = rec;
    cancelledRef.current = false;
    rec.start();
    if (meter) meterLoop();
    buzz(30);
    setRecSeconds(0);
    setVoice("recording");
    const t0 = Date.now();
    timerRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setRecSeconds(s);
      sampleLevel();
      if (s >= MAX_REC_SEC && rec.state === "recording") rec.stop();
    }, 250);
  }, [voice, isLoading, token, send, addError]);

  const cancelVoice = useCallback(() => {
    if (recorderRef.current?.state !== "recording") return;
    cancelledRef.current = true;
    recorderRef.current.stop();
  }, []);
  const getLevel = useCallback(() => levelRef.current, []);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (recorderRef.current?.state === "recording") { cancelledRef.current = true; recorderRef.current.stop(); }
  }, []);

  // ── File: PDF / image → /api/v2/read-file → send its text as a message ──────
  const handleFile = useCallback(async (picked: File) => {
    if (fileBusy || isLoading) return;
    setFileBusy(true);
    try {
      const file = await shrinkImage(picked);
      const fd = new FormData();
      fd.append("file", file, file.name);
      const res = await fetch("/api/v2/read-file", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok || !data.text) throw new Error(data.error ?? `HTTP ${res.status}`);
      setFileBusy(false);
      send(`צירפתי מסמך (${picked.name}). צור ממנו הצעת מחיר:\n\n${data.text}`, `📎 ${picked.name}`);
    } catch (e) {
      setFileBusy(false);
      const code = e instanceof Error ? e.message : "";
      addError(FILE_ERRORS[code] ?? "לא הצלחתי לקרוא את הקובץ — נסה שוב או תאר במילים");
    }
  }, [fileBusy, isLoading, token, send, addError]);

  // ── Manual edits ────────────────────────────────────────────────────────────
  const edit = useCallback((patch: Q) => setQuote((prev) => ({ ...prev, ...patch })), []);
  const editClient = useCallback((patch: Partial<QuoteV2["client"]>) =>
    setQuote((prev) => ({ ...prev, client: { ...(prev.client ?? {}), ...patch } })), []);
  const setItems = useCallback((fn: (items: QuoteItemV2[]) => QuoteItemV2[]) =>
    setQuote((prev) => ({ ...prev, items: fn(prev.items ?? []) })), []);

  // ✨ AI options the user picks from (item wording, notes, terms) — nothing is applied without a tap.
  const aiSuggest = useCallback<AiSuggest>(async (kind, index, imageUrl) => {
    const res = await fetch("/api/v2/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, quote, index, image_url: imageUrl }),
    });
    const data = (await res.json().catch(() => ({}))) as { options?: unknown[]; error?: string };
    if (!res.ok || !Array.isArray(data.options)) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data.options;
  }, [token, quote]);

  const addSuggestion = useCallback((i: number) => {
    const s = suggestions[i];
    if (!s) return;
    const at = quote.items?.length ?? 0;
    setItems((list) => [...list, normalizeItem({ name: s.name, description: s.description ?? "", unit: DEFAULT_UNIT })]);
    setSuggestions((prev) => prev.filter((_, j) => j !== i));
    setFlash([at]);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash([]), 2200);
  }, [suggestions, quote.items, setItems]);

  // 📷 Site photos: upload → add to the quote → the AI looks at the photo and offers items as "+ add" chips.
  const [photoBusy, setPhotoBusy] = useState<string>(""); // status line while uploading / looking
  const addPhotos = useCallback(async (files: File[]) => {
    const room = MAX_PHOTOS - (quote.images?.length ?? 0);
    const list = files.filter((f) => f.type.startsWith("image/")).slice(0, Math.max(0, room));
    if (!list.length) { setPhotoBusy(room <= 0 ? `אפשר עד ${MAX_PHOTOS} תמונות` : ""); return; }
    let failed = 0;
    for (const [k, f] of list.entries()) {
      setPhotoBusy(list.length > 1 ? `מעלה תמונה ${k + 1} מתוך ${list.length}...` : "מעלה תמונה...");
      try {
        const file = await shrinkImage(f);
        const fd = new FormData();
        fd.append("file", file, file.name);
        const res = await fetch("/api/v2/upload-photo", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
        const data = (await res.json().catch(() => ({}))) as { url?: string };
        if (!res.ok || !data.url) throw new Error();
        const url = data.url;
        setQuote((prev) => ({ ...prev, images: [...(prev.images ?? []), url] }));
        setPhotoBusy("✨ מסתכל על התמונה...");
        const opts = (await aiSuggest("photo", undefined, url).catch(() => [])) as Suggestion[];
        setSuggestions((prev) => {
          const have = new Set([...prev.map((s) => s.name.trim()), ...(quote.items ?? []).map((it) => it.name.trim())]);
          return [...opts.filter((o) => o?.name?.trim() && !have.has(o.name.trim())), ...prev].slice(0, 8);
        });
      } catch {
        failed++;
      }
    }
    setPhotoBusy(failed ? `${failed === 1 ? "תמונה אחת לא עלתה" : `${failed} תמונות לא עלו`} — נסה שוב` : "");
  }, [quote.images, quote.items, token, aiSuggest]);

  const removePhoto = useCallback((url: string) =>
    setQuote((prev) => ({ ...prev, images: (prev.images ?? []).filter((u) => u !== url) })), []);

  const resumeDraft = useCallback(() => {
    if (!pendingDraft) return;
    setMessages(pendingDraft.messages.length ? pendingDraft.messages : [{ role: "assistant", content: greeting }]);
    setQuote(pendingDraft.quote);
    setRestored(true);
    setPendingDraft(null);
  }, [pendingDraft, greeting]);

  const discardDraft = useCallback(() => {
    clearDraft(aiContext.user_id);
    setPendingDraft(null);
  }, [aiContext.user_id]);

  // Two taps instead of confirm(): the BDK app's WebView blocks JS dialogs, so confirm() always returned false.
  const startOver = useCallback(() => {
    if (!confirmNew) {
      setConfirmNew(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmNew(false), 4000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmNew(false);
    clearDraft(aiContext.user_id);
    setQuote({});
    setMessages([{ role: "assistant", content: greeting }]);
    setRestored(false);
    setSaveState("idle");
    setChatOpen(false);
    setInput("");
    setSuggestions([]);
    setUndo(null);
  }, [confirmNew, aiContext.user_id, greeting]);

  // ── Save to Bubble ──────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (saveState === "saving" || saveState === "saved") return;
    setSaveState("saving");
    setSaveError("");
    try {
      const res = await fetch("/api/v2/approve-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ quote: { ...quote, has_tax: quote.has_tax ?? false }, bubble_env: bubbleEnv }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; redirect_url?: string; message?: string };
      if (!res.ok || !data.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
      setSaveState("saved");
      clearDraft(aiContext.user_id);
      if (data.redirect_url) {
        const url = data.redirect_url;
        setTimeout(() => {
          if (window.parent !== window) window.parent.postMessage({ type: "quote_redirect", url }, "*");
          else window.location.href = url;
        }, 2500);
      }
    } catch (e) {
      setSaveState("error");
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }, [saveState, token, quote, bubbleEnv, aiContext.user_id]);

  // ── Render ──────────────────────────────────────────────────────────────────
  const composer = (
    <Composer
      input={input}
      setInput={setInput}
      onSend={handleSend}
      onVoice={handleVoice}
      onCancelVoice={cancelVoice}
      getLevel={getLevel}
      onFile={handleFile}
      voice={voice}
      recSeconds={recSeconds}
      busy={isLoading || fileBusy}
      placeholder={hasQuote ? "מה לשנות?" : "כתוב, דבר או צרף מסמך"}
    />
  );

  const undoBtn = undo && hasQuote && !isLoading ? (
    <button
      onClick={() => { setQuote(undo); setUndo(null); setFlash([]); }}
      style={{ ...chipStyle, display: "block", margin: "0 0 8px", fontSize: 12, padding: "5px 12px", color: "#4b5563", background: "#fff" }}
    >↩ בטל את השינוי האחרון של ה-AI</button>
  ) : null;

  const header = (
    <div dir="rtl" style={{ flexShrink: 0, padding: "10px 16px", borderBottom: "1px solid #e8eaed", display: "flex", alignItems: "center", gap: 10, color: "#1a1a2e" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{aiContext.company_name}</div>
        <div style={{ fontSize: 12, color: "#6d28d9", marginTop: 2 }}>
          הצעת מחיר עם AI{bubbleEnv === "test" && <span style={{ color: "#dc2626" }}> · מצב בדיקה</span>}
        </div>
      </div>
      {started && (
        <button onClick={startOver} style={{
          ...chipStyle, fontSize: 12, padding: "6px 12px",
          ...(confirmNew ? { background: "#dc2626", color: "#fff", border: "1px solid #dc2626" } : {}),
        }}>{confirmNew ? "למחוק ולהתחיל? לחץ שוב" : "הצעה חדשה"}</button>
      )}
    </div>
  );

  const messageList = (
    <div ref={messagesRef} dir="rtl" style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12, color: "#1a1a2e" }}>
      {restored && (
        <div style={{ alignSelf: "center", fontSize: 12, color: "#6b7280", background: "#f3f4f6", borderRadius: 12, padding: "4px 12px" }}>
          שחזרנו את הטיוטה האחרונה שלך
        </div>
      )}
      {messages.map((m, i) => <Bubble key={i} m={m} />)}
      {fileBusy && <Bubble m={{ role: "assistant", content: "קורא את הקובץ..." }} />}
    </div>
  );

  const panel = (
    <QuotePanelV2
      quote={quote}
      companyName={aiContext.company_name}
      companyLogo={aiContext.company_logo}
      onEdit={edit}
      onEditClient={editClient}
      onSetItems={setItems}
      onSwitchMode={(m) => setQuote((prev) => switchMode(prev, m))}
      onSave={handleSave}
      saveState={saveState}
      saveError={saveError}
      isTest={bubbleEnv === "test"}
      flash={flash}
      suggestions={suggestions}
      onAddSuggestion={addSuggestion}
      aiSuggest={aiSuggest}
      onAddPhotos={addPhotos}
      onRemovePhoto={removePhoto}
      photoBusy={photoBusy}
    />
  );

  // 1) Start screen — before anything was said
  if (!started) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#fff", overflow: "hidden" }}>
        {header}
        <StartScreen
          input={input}
          setInput={setInput}
          onSend={handleSend}
          onVoice={handleVoice}
          onCancelVoice={cancelVoice}
          getLevel={getLevel}
          onFile={handleFile}
          voice={voice}
          recSeconds={recSeconds}
          busy={isLoading || fileBusy}
          error={messages.find((m) => m.error)?.content}
          draft={pendingDraft}
          onResume={resumeDraft}
          onDiscard={discardDraft}
        />
      </div>
    );
  }

  // 2) Mobile — the quote is the screen; the chat is a dock at the bottom
  if (isMobile) {
    const lastAi = [...messages].reverse().find((m) => m.role === "assistant");
    const showChat = chatOpen || !hasQuote;
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#fff", overflow: "hidden" }}>
        {header}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {showChat ? (
            <>
              {hasQuote && (
                <div dir="rtl" style={{ flexShrink: 0, padding: "10px 12px", borderBottom: "1px solid #f0f0f0" }}>
                  <button onClick={() => setChatOpen(false)} style={{
                    width: "100%", padding: "12px 16px", borderRadius: 14, border: "none", cursor: "pointer", fontFamily: "inherit",
                    fontSize: 15, fontWeight: 700, color: "#fff", background: `linear-gradient(135deg, ${PURPLE}, ${PURPLE_2})`,
                  }}>📋 חזרה להצעה</button>
                </div>
              )}
              {messageList}
            </>
          ) : panel}
        </div>
        <div dir="rtl" style={{ flexShrink: 0, borderTop: "1px solid #e8eaed", background: "#fafafa", padding: "8px 10px calc(10px + env(safe-area-inset-bottom))" }}>
          {!showChat && lastAi && (
            <button onClick={() => setChatOpen(true)} aria-label="פתיחת כל השיחה" style={{
              display: "flex", gap: 8, alignItems: "flex-start", width: "100%", textAlign: "right", border: "none", background: "transparent",
              padding: 0, marginBottom: 10, fontFamily: "inherit", cursor: "pointer",
            }}>
              <AiAvatar />
              <span style={{
                flex: 1, minWidth: 0, background: lastAi.error ? "#fef2f2" : "#ede9fe", borderRadius: "16px 4px 16px 16px",
                padding: "8px 12px", fontSize: 14, lineHeight: 1.5, color: lastAi.error ? "#b91c1c" : "#2e1065",
              }}>
                {lastAi.loading ? <Dots /> : (
                  <span style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{lastAi.content}</span>
                )}
                <span style={{ display: "block", fontSize: 11, color: PURPLE, marginTop: 4, fontWeight: 600 }}>כל השיחה ←</span>
              </span>
            </button>
          )}
          {undoBtn}
          {composer}
        </div>
      </div>
    );
  }

  // 3) Desktop — quote and chat side by side
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#fff", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0, direction: "ltr" }}>
        {hasQuote && (
          <div style={{ width: "46%", minWidth: 340, borderRight: "1px solid #e5e7eb", display: "flex", flexDirection: "column", minHeight: 0 }}>
            {panel}
          </div>
        )}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {header}
          {messageList}
          <div dir="rtl" style={{ padding: "8px 14px 14px" }}>{undoBtn}{composer}</div>
        </div>
      </div>
    </div>
  );
}

// ── Start screen ──────────────────────────────────────────────────────────────
function StartScreen({ input, setInput, onSend, onVoice, onCancelVoice, getLevel, onFile, voice, recSeconds, busy, error, draft, onResume, onDiscard }: {
  input: string; setInput: (v: string) => void; onSend: () => void; onVoice: () => void; onCancelVoice: () => void; getLevel: () => number; onFile: (f: File) => void;
  voice: Voice; recSeconds: number; busy: boolean; error?: string;
  draft: Draft | null; onResume: () => void; onDiscard: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const recording = voice === "recording";
  const working = busy || voice === "transcribing";
  return (
    <div dir="rtl" style={{ flex: 1, overflowY: "auto", color: "#1a1a2e" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "22px 18px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
        {draft && (
          <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 14, padding: "12px 14px" }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>יש לך טיוטה שלא נשמרה</div>
            <div style={{ fontSize: 13, color: "#4b5563", marginTop: 2 }}>
              {[draft.quote.title || draft.quote.client?.name, `${draft.quote.items?.length ?? 0} פריטים`, timeAgo(draft.at)].filter(Boolean).join(" · ")}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={onResume} style={{ ...chipStyle, background: PURPLE, color: "#fff", border: "none", fontSize: 13 }}>המשך בטיוטה</button>
              <button onClick={onDiscard} style={{ ...chipStyle, fontSize: 13, color: "#6b7280" }}>מחק</button>
            </div>
          </div>
        )}
        <div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>הצעת מחיר חדשה</div>
          <div style={{ fontSize: 14, color: "#6b7280", marginTop: 4, lineHeight: 1.6 }}>כתוב למי ההצעה, מה כלול וכמה זה עולה — ואנחנו ניצור לך את ההצעה.</div>
        </div>

        <div style={{ border: "1px solid #ddd6fe", borderRadius: 18, padding: 12, background: "#fff", boxShadow: "0 1px 8px rgba(124,58,237,0.08)" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={'למשל: לדני כהן מחולון — ריצוף 20 מ"ר ב-250 למ"ר, פינוי פסולת 400'}
            rows={4}
            disabled={working || recording}
            style={{ width: "100%", border: "none", outline: "none", resize: "none", fontSize: 16, lineHeight: 1.6, fontFamily: "inherit", direction: "rtl", background: "transparent", color: "#1a1a2e", boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={onSend} disabled={!input.trim() || working} style={{
              padding: "10px 22px", borderRadius: 24, border: "none", fontSize: 15, fontWeight: 700, fontFamily: "inherit", cursor: input.trim() ? "pointer" : "default",
              background: input.trim() && !working ? `linear-gradient(135deg, ${PURPLE}, ${PURPLE_2})` : "#e8eaed", color: input.trim() && !working ? "#fff" : "#9ca3af",
            }}>צור הצעה ←</button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#9ca3af", fontSize: 13 }}>
          <div style={{ flex: 1, height: 1, background: "#eee" }} />או<div style={{ flex: 1, height: 1, background: "#eee" }} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <div style={{ position: "relative", width: 84, height: 84, margin: 12 }}>
            {recording && <VoiceRing getLevel={getLevel} />}
            <button onClick={onVoice} disabled={working} aria-label={recording ? "עצור ושלח" : "הקלטה"} style={{
              position: "relative", width: 84, height: 84, borderRadius: "50%", border: "none", cursor: working ? "default" : "pointer", fontSize: 34, color: "#fff",
              background: recording ? "#dc2626" : `linear-gradient(135deg, ${PURPLE}, ${PURPLE_2})`,
              boxShadow: recording ? "none" : "0 4px 14px rgba(124,58,237,0.35)",
            }}>{recording ? "■" : voice === "transcribing" ? <Dots light /> : "🎙"}</button>
          </div>
          {recording && <VoiceBars getLevel={getLevel} width={180} />}
          <div style={{ fontSize: 14, color: recording ? "#dc2626" : "#4b5563", fontWeight: recording ? 700 : 400 }}>
            {recording ? `מקליט ${mmss(recSeconds)} — לחץ לסיום` : voice === "transcribing" ? "מתמלל..." : "לחץ ודבר — ספר על העבודה"}
          </div>
          {recording && (
            <button onClick={onCancelVoice} style={{ ...chipStyle, fontSize: 13, color: "#6b7280", background: "#fff" }}>🗑 ביטול הקלטה</button>
          )}
        </div>

        <button onClick={() => fileRef.current?.click()} disabled={working || recording} style={{
          display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "14px 16px", borderRadius: 14,
          border: "1.5px dashed #c4b5fd", background: "#fff", cursor: "pointer", fontFamily: "inherit", textAlign: "right", color: "#1a1a2e",
        }}>
          <span style={{ fontSize: 24 }}>📎</span>
          <span>
            <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>{busy ? "קורא את הקובץ..." : "יש לך מסמך או תמונה?"}</span>
            <span style={{ display: "block", fontSize: 12, color: "#6b7280" }}>הצעה ישנה, כתב יד, צילום מסך — PDF או תמונה</span>
          </span>
        </button>
        <input ref={fileRef} type="file" accept="application/pdf,image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} />

        {error && <div style={{ fontSize: 13, color: "#b91c1c", background: "#fef2f2", borderRadius: 10, padding: "8px 12px" }}>{error}</div>}
      </div>
    </div>
  );
}

// ── Composer (chat input with mic + attach) ───────────────────────────────────
function Composer({ input, setInput, onSend, onVoice, onCancelVoice, getLevel, onFile, voice, recSeconds, busy, placeholder }: {
  input: string; setInput: (v: string) => void; onSend: () => void; onVoice: () => void; onCancelVoice: () => void; getLevel: () => number; onFile: (f: File) => void;
  voice: Voice; recSeconds: number; busy: boolean; placeholder: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recording = voice === "recording";
  const canSend = !!input.trim() && !busy;
  const submit = () => { onSend(); if (taRef.current) taRef.current.style.height = "auto"; };
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, border: "1px solid #e2e6ea", borderRadius: 26, padding: "6px 8px", background: "#fff", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
      {recording ? (
        <button onClick={onCancelVoice} aria-label="ביטול הקלטה" style={{ ...roundBtn, border: "none", background: "transparent" }}>🗑</button>
      ) : (
        <button onClick={() => fileRef.current?.click()} disabled={busy || voice !== "idle"} aria-label="צירוף מסמך או תמונה" style={{ ...roundBtn, border: "none", background: "transparent", color: "#6b7280" }}>📎</button>
      )}
      <input ref={fileRef} type="file" accept="application/pdf,image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} />
      {voice !== "idle" ? (
        <button onClick={onVoice} disabled={voice === "transcribing"} style={{ flex: 1, minWidth: 0, minHeight: 40, border: "none", background: "transparent", textAlign: "right", fontFamily: "inherit", fontSize: 15, cursor: recording ? "pointer" : "default", color: recording ? "#dc2626" : "#6d28d9", display: "flex", alignItems: "center", gap: 8 }}>
          {recording ? <><span style={{ fontVariantNumeric: "tabular-nums" }}>{mmss(recSeconds)}</span><VoiceBars getLevel={getLevel} /></> : <>מתמלל... <Dots /></>}
        </button>
      ) : (
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && window.innerWidth >= 768) { e.preventDefault(); if (canSend) submit(); } }}
          onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }}
          placeholder={placeholder}
          rows={1}
          disabled={busy}
          style={{ flex: 1, alignSelf: "center", border: "none", outline: "none", resize: "none", fontSize: 16, lineHeight: 1.5, maxHeight: 120, direction: "rtl", fontFamily: "inherit", background: "transparent", color: "#1a1a2e", padding: "6px 0" }}
        />
      )}
      {canSend && voice === "idle" ? (
        <button onClick={submit} onMouseDown={(e) => e.preventDefault()} aria-label="שלח" style={{ ...roundBtn, width: 40, height: 40, border: "none", background: `linear-gradient(135deg, ${PURPLE}, #6d28d9)`, color: "#fff" }}>←</button>
      ) : (
        <button onClick={onVoice} disabled={voice === "transcribing" || busy} aria-label={recording ? "עצור ושלח" : "הקלטה"} style={{
          ...roundBtn, width: 40, height: 40, border: "none", fontSize: 18,
          background: recording ? "#dc2626" : `linear-gradient(135deg, ${PURPLE}, ${PURPLE_2})`, color: "#fff",
          boxShadow: recording ? "0 0 0 5px #fee2e2" : "none",
        }}>{recording ? "■" : "🎙"}</button>
      )}
    </div>
  );
}

/** Runs `draw(level)` every animation frame while mounted — the parent never re-renders for it. */
function useLevelFrames(getLevel: () => number, draw: (level: number) => void) {
  const drawRef = useRef(draw);
  useEffect(() => { drawRef.current = draw; });
  useEffect(() => {
    let raf = 0;
    const loop = () => { drawRef.current(getLevel()); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [getLevel]);
}

/** Moving voice bars (like WhatsApp / Siri): purple while speech is heard, flat gray on silence. */
function VoiceBars({ getLevel, width }: { getLevel: () => number; width?: number }) {
  const N = 26;
  const boxRef = useRef<HTMLDivElement>(null);
  const hist = useRef<number[]>(Array(N).fill(0));
  const last = useRef(0);
  useLevelFrames(getLevel, (level) => {
    const now = performance.now();
    if (now - last.current < 70) return;
    last.current = now;
    hist.current = [...hist.current.slice(1), level];
    const bars = boxRef.current?.children;
    if (!bars) return;
    hist.current.forEach((v, i) => {
      const b = bars[i] as HTMLElement | undefined;
      if (!b) return;
      b.style.height = `${Math.round(3 + v * 21)}px`;
      b.style.background = v > 0.05 ? PURPLE : "#d1d5db";
    });
  });
  return (
    <div ref={boxRef} aria-hidden style={{ flex: width ? undefined : 1, width, minWidth: 0, height: 26, display: "flex", alignItems: "center", justifyContent: "center", gap: 2, overflow: "hidden" }}>
      {Array.from({ length: N }, (_, i) => (
        <span key={i} style={{ flex: "0 0 3px", height: 3, borderRadius: 2, background: "#d1d5db", transition: "height 70ms linear" }} />
      ))}
    </div>
  );
}

/** Soft ring behind the big mic that grows with the voice. */
function VoiceRing({ getLevel }: { getLevel: () => number }) {
  const ref = useRef<HTMLDivElement>(null);
  const smooth = useRef(0);
  useLevelFrames(getLevel, (level) => {
    smooth.current = smooth.current * 0.7 + level * 0.3;
    if (ref.current) ref.current.style.transform = `scale(${(1.12 + smooth.current * 0.45).toFixed(3)})`;
  });
  return <div ref={ref} aria-hidden style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "#fee2e2", transform: "scale(1.12)" }} />;
}

function AiAvatar() {
  return (
    <span aria-hidden style={{
      flexShrink: 0, width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 14, fontWeight: 800, color: "#fff", background: "#25D366",
    }}>ת</span>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-start" }}>
        <div style={{
          maxWidth: "85%", padding: "10px 16px", borderRadius: "16px 4px 16px 16px", fontSize: 15, lineHeight: 1.7,
          wordBreak: "break-word", whiteSpace: "pre-wrap", background: "#f3f4f6", color: "#1a1a2e",
        }}>{m.display ?? m.content}</div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", justifyContent: "flex-end" }}>
      <div aria-live="polite" style={{
        maxWidth: "85%", padding: "10px 16px", borderRadius: "4px 16px 16px 16px", fontSize: 15, lineHeight: 1.7,
        wordBreak: "break-word", whiteSpace: "pre-wrap",
        background: m.error ? "#fef2f2" : "#ede9fe", color: m.error ? "#b91c1c" : "#2e1065",
      }}>
        {m.loading ? <Dots /> : (m.display ?? m.content)}
      </div>
      <AiAvatar />
    </div>
  );
}

// ── Quote panel ───────────────────────────────────────────────────────────────
function QuotePanelV2({
  quote, companyName, companyLogo, onEdit, onEditClient, onSetItems, onSwitchMode, onSave, saveState, saveError, isTest, flash,
  suggestions, onAddSuggestion, aiSuggest, onAddPhotos, onRemovePhoto, photoBusy,
}: {
  quote: Q;
  companyName: string;
  companyLogo?: string;
  onEdit: (patch: Q) => void;
  onEditClient: (patch: Partial<QuoteV2["client"]>) => void;
  onSetItems: (fn: (items: QuoteItemV2[]) => QuoteItemV2[]) => void;
  onSwitchMode: (m: PricingMode) => void;
  onSave: () => void;
  saveState: SaveState;
  saveError: string;
  isTest: boolean;
  flash: number[];
  suggestions: Suggestion[];
  onAddSuggestion: (i: number) => void;
  aiSuggest: AiSuggest;
  onAddPhotos: (files: File[]) => void;
  onRemovePhoto: (url: string) => void;
  photoBusy: string;
}) {
  const perItem = quote.pricing_mode === "per_item";
  const items = quote.items ?? [];
  const t = computeTotals(quote);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  const missing: string[] = [];
  if (!items.length) missing.push("פריטים");
  if (!quote.title?.trim()) missing.push("כותרת");
  if (!quote.client?.name?.trim()) missing.push("שם לקוח");
  if (!perItem && !(quote.total && quote.total > 0)) missing.push("מחיר");
  if (perItem && t.subtotal <= 0) missing.push("מחירים");
  const canSave = missing.length === 0;

  const updateItem = (i: number, patch: Partial<QuoteItemV2>) =>
    onSetItems((list) => list.map((it, j) => (j === i ? normalizeItem({ ...it, ...patch }) : it)));

  // ── Drag to reorder (one handle per row; pointer events work for touch and mouse) ──
  const listRef = useRef<HTMLDivElement>(null);
  const dragRects = useRef<DOMRect[]>([]);
  const dragY0 = useRef(0);
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number; h: number } | null>(null);
  const onDragStart = (e: React.PointerEvent, i: number) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRects.current = [...(listRef.current?.querySelectorAll("[data-row]") ?? [])].map((el) => el.getBoundingClientRect());
    dragY0.current = e.clientY;
    setDrag({ from: i, to: i, dy: 0, h: dragRects.current[i]?.height ?? 0 });
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const rects = dragRects.current;
    const dy = e.clientY - dragY0.current;
    const center = rects[drag.from].top + rects[drag.from].height / 2 + dy;
    let to = rects.findIndex((r) => center < r.top + r.height / 2);
    if (to < 0) to = rects.length - 1;
    else if (to > drag.from) to -= 1;
    setDrag({ ...drag, dy, to });
  };
  const onDragEnd = () => {
    if (drag && drag.to !== drag.from) {
      const { from, to } = drag;
      onSetItems((list) => {
        const next = [...list];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    }
    setDrag(null);
  };
  const rowShift = (i: number): number => {
    if (!drag || i === drag.from) return 0;
    const h = drag.h;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -h;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return h;
    return 0;
  };

  return (
    <div dir="rtl" style={{ flex: 1, overflowY: "auto", color: "#1a1a2e", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "20px 18px" }}>
        {/* Company */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          {companyLogo ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={companyLogo} alt="" style={{ width: 44, height: 44, objectFit: "contain", borderRadius: 8, border: "1px solid #e5e7eb" }} />
          ) : (
            <div style={{ width: 44, height: 44, borderRadius: 8, background: PURPLE_LIGHT, color: PURPLE, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>
              {companyName.charAt(0) || "?"}
            </div>
          )}
          <div style={{ fontWeight: 700, fontSize: 15 }}>{companyName}</div>
        </div>

        <div style={{ textAlign: "center", fontSize: 20, fontWeight: 800, paddingBottom: 12, borderBottom: `2px solid ${PURPLE}`, marginBottom: 14 }}>הצעת מחיר</div>

        <Editable value={quote.title ?? ""} placeholder="כותרת ההצעה" onChange={(v) => onEdit({ title: v })} style={{ fontWeight: 600, fontSize: 14 }} />

        {/* Client */}
        <Box title="פרטי לקוח">
          <Editable value={quote.client?.name ?? ""} placeholder="שם לקוח" onChange={(v) => onEditClient({ name: v })} style={{ fontWeight: 700 }} />
          <Editable value={quote.client?.address ?? ""} placeholder="כתובת" onChange={(v) => onEditClient({ address: v })} style={{ fontSize: 13, color: "#4b5563" }} />
          <div style={{ display: "flex", gap: 10 }}>
            <Editable value={quote.client?.phone ?? ""} placeholder="טלפון" onChange={(v) => onEditClient({ phone: v })} style={{ fontSize: 13, color: "#4b5563", direction: "ltr", textAlign: "right" }} />
            <Editable value={quote.client?.email ?? ""} placeholder="מייל" onChange={(v) => onEditClient({ email: v })} style={{ fontSize: 13, color: "#4b5563", direction: "ltr", textAlign: "right" }} />
          </div>
        </Box>

        {/* Mode switch */}
        <div role="radiogroup" aria-label="סוג תמחור" style={{ display: "flex", background: "#f3f4f6", borderRadius: 10, padding: 3, margin: "14px 0 10px" }}>
          {(["total", "per_item"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={(quote.pricing_mode ?? "total") === m}
              onClick={() => onSwitchMode(m)}
              style={{
                flex: 1, padding: "7px 0", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
                background: (quote.pricing_mode ?? "total") === m ? "#fff" : "transparent",
                color: (quote.pricing_mode ?? "total") === m ? PURPLE : "#6b7280",
                boxShadow: (quote.pricing_mode ?? "total") === m ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
              }}
            >{m === "total" ? "סכום אחד" : "מחיר לכל פריט"}</button>
          ))}
        </div>

        {/* Items */}
        <div ref={listRef} style={{ marginBottom: 8 }}>
          {items.map((it, i) => (
            <div key={i} data-row style={{
              padding: "10px 6px", margin: "0 -6px", borderBottom: "1px solid #f3f4f6", borderRadius: 8,
              // Raised only while dragging — otherwise rows would paint over the sticky save bar.
              position: "relative", zIndex: drag?.from === i ? 2 : undefined,
              transform: `translateY(${drag?.from === i ? drag.dy : rowShift(i)}px)`,
              transition: drag?.from === i ? "background-color .6s" : "transform .15s, background-color .6s",
              boxShadow: drag?.from === i ? "0 6px 18px rgba(0,0,0,0.15)" : "none",
              background: drag?.from === i ? "#fff" : flash.includes(i) ? FLASH_BG : perItem && !it.unit_price ? MISSING_BG : "transparent",
            }}>
              {editingIdx === i ? (
                <ItemEditor
                  item={it}
                  perItem={perItem}
                  onDone={(patch) => { updateItem(i, patch); setEditingIdx(null); }}
                  onCancel={() => {
                    // A new item that never got a name is removed rather than left blank.
                    if (!it.name.trim()) onSetItems((list) => list.filter((_, j) => j !== i));
                    setEditingIdx(null);
                  }}
                  onDelete={() => { onSetItems((list) => list.filter((_, j) => j !== i)); setEditingIdx(null); }}
                  onReword={() => aiSuggest("item", i) as Promise<Suggestion[]>}
                />
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  {items.length > 1 && (
                    <span
                      role="button"
                      aria-label={`גרירת פריט ${i + 1}`}
                      onPointerDown={(e) => onDragStart(e, i)}
                      onPointerMove={onDragMove}
                      onPointerUp={onDragEnd}
                      onPointerCancel={onDragEnd}
                      style={{ flexShrink: 0, width: 24, alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", color: "#c4b5fd", fontSize: 18, cursor: drag ? "grabbing" : "grab", touchAction: "none", userSelect: "none" }}
                    >⠿</span>
                  )}
                  <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: "50%", background: PURPLE_LIGHT, color: PURPLE, fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                  <button onClick={() => setEditingIdx(i)} style={{ flex: 1, minWidth: 0, textAlign: "right", background: "none", border: "none", padding: 0, cursor: "text", fontFamily: "inherit", color: "inherit" }} aria-label={`עריכת פריט ${i + 1}`}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{it.name}</div>
                    {it.description && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2, lineHeight: 1.5 }}>{it.description}</div>}
                    {perItem && (
                      <div style={{ fontSize: 12, color: "#4b5563", marginTop: 4, display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span>{formatQty(it.quantity)} {it.unit} × {it.unit_price ? formatILS(it.unit_price) : <span style={{ color: "#b45309", fontWeight: 700 }}>+ הוסף מחיר</span>}</span>
                        <span style={{ fontWeight: 700, color: "#111827" }}>{formatILS(lineTotal(it))}</span>
                      </div>
                    )}
                  </button>
                </div>
              )}
            </div>
          ))}
          <button
            onClick={() => { onSetItems((list) => [...list, normalizeItem({ name: "", unit: DEFAULT_UNIT })]); setEditingIdx(items.length); }}
            style={{ ...chipStyle, marginTop: 10, fontSize: 13 }}
          >+ הוספת פריט</button>
          {suggestions.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>✨ אולי כדאי להוסיף:</div>
              <div className="v2-hscroll" style={{ display: "flex", flexWrap: "nowrap", gap: 6, overflowX: "auto", margin: "0 -18px", padding: "2px 18px 6px", scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
                <style>{`.v2-hscroll::-webkit-scrollbar{display:none}`}</style>
                {suggestions.map((s, i) => (
                  <button key={s.name} title={s.description} onClick={() => onAddSuggestion(i)}
                    style={{ ...chipStyle, flexShrink: 0, whiteSpace: "nowrap", fontSize: 12, padding: "6px 12px", background: "#faf5ff", border: "1px dashed #c4b5fd" }}>+ {s.name}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        <PhotosBox images={quote.images ?? []} onAdd={onAddPhotos} onRemove={onRemovePhoto} busy={photoBusy} />

        {/* Totals */}
        <div style={{ margin: "14px 0", padding: "12px 14px", background: "#f5f3ff", borderRadius: 10, border: "1px solid #ddd6fe", fontSize: 13 }}>
          {perItem ? (
            <>
              <Row label="סה״כ פריטים" value={formatILS(t.subtotal)} />
              <Row
                label="הנחה"
                value={<NumberEdit value={quote.discount_amount ?? 0} onChange={(n) => onEdit({ discount_amount: n })} render={(n) => (n ? `−${formatILS(n)}` : "הוספה ✏️")} />}
              />
              {quote.has_tax && <Row label="לפני מע״מ" value={formatILS(t.beforeVat)} />}
              {quote.has_tax && <Row label="מע״מ 18%" value={formatILS(t.vat)} />}
              <Row label={quote.has_tax ? "סה״כ כולל מע״מ" : "סה״כ לתשלום"} value={formatILS(t.grandTotal)} strong />
              {t.missingPrices > 0 && (
                <div style={{ marginTop: 6, fontSize: 12, color: "#b45309" }}>{t.missingPrices === 1 ? "לפריט אחד אין מחיר — הוא יישמר" : `ל-${t.missingPrices} פריטים אין מחיר — הם יישמרו`} עם ₪0, ואפשר להשלים אחר כך.</div>
              )}
            </>
          ) : (
            <>
              {quote.has_tax && t.vat > 0 && <Row label="לפני מע״מ" value={formatILS(t.beforeVat)} />}
              {quote.has_tax && t.vat > 0 && <Row label="מע״מ 18%" value={formatILS(t.vat)} />}
              <Row
                label={quote.has_tax ? "סה״כ כולל מע״מ" : "סה״כ לתשלום"}
                strong
                value={<NumberEdit value={quote.total ?? 0} onChange={(n) => onEdit({ total: n })} render={(n) => (n ? formatILS(n) : "עדכון מחיר ✏️")} />}
              />
            </>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: "#4b5563", cursor: "pointer" }}>
            <input type="checkbox" checked={!!quote.has_tax} onChange={(e) => onEdit({ has_tax: e.target.checked })} style={{ accentColor: PURPLE }} />
            {perItem ? "להוסיף מע״מ 18%" : "המחיר כולל מע״מ"}
          </label>
        </div>

        {(() => {
          const termsText = [quote.warranty, quote.terms].filter(Boolean).join("\n");
          const append = (cur: string, lines: string[]) => [cur, ...lines].filter((s) => s.trim()).join("\n");
          return (
            <>
              <Box title="תנאים ואחריות">
                <Editable multiline value={termsText} placeholder="הוספת תנאים ✏️" onChange={(v) => onEdit({ terms: v, warranty: "" })} style={{ fontSize: 12, color: "#4b5563" }} />
                <AiLines load={() => aiSuggest("terms") as Promise<{ text: string }[]>} onAdd={(lines) => onEdit({ terms: append(termsText, lines), warranty: "" })} />
              </Box>
              <Box title="הערות">
                <Editable multiline value={quote.comments ?? ""} placeholder="הוספת הערות ✏️" onChange={(v) => onEdit({ comments: v })} style={{ fontSize: 12, color: "#4b5563" }} />
                <AiLines load={() => aiSuggest("notes") as Promise<{ text: string }[]>} onAdd={(lines) => onEdit({ comments: append(quote.comments ?? "", lines) })} />
              </Box>
            </>
          );
        })()}
        <div style={{ height: 90 }} />
      </div>

      {/* Save */}
      <div style={{ position: "sticky", bottom: 0, zIndex: 5, background: "#fff", borderTop: "1px solid #f0f0f0", boxShadow: "0 -8px 16px rgba(255,255,255,0.9)", padding: "12px 18px 16px", textAlign: "center" }}>
        <button
          onClick={onSave}
          disabled={!canSave || saveState === "saving" || saveState === "saved"}
          style={{
            padding: "14px 36px", borderRadius: 50, border: "none", fontSize: 16, fontWeight: 700, color: "#fff",
            background: saveState === "error" ? "linear-gradient(135deg,#ef4444,#dc2626)" : `linear-gradient(135deg, ${PURPLE}, ${PURPLE_2})`,
            opacity: canSave ? 1 : 0.45, cursor: canSave ? "pointer" : "default",
          }}
        >
          {saveState === "saving" ? "שומר..." : saveState === "saved" ? "✓ נשמר — מעבירים אותך" : saveState === "error" ? "השמירה נכשלה — נסה שוב" : "שמירה ומעבר להצעה"}
        </button>
        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
          {saveState === "error"
            ? `ההצעה לא נשמרה (${saveError}). הטיוטה שמורה כאן — אפשר לנסות שוב.`
            : canSave
              ? `נשמר כטיוטה${isTest ? " ב-version-test" : ""}, ואז תראה את ה-PDF עם העיצוב שלך`
              : `חסר: ${missing.join(", ")}`}
        </div>
      </div>
    </div>
  );
}

// ── Item editor ───────────────────────────────────────────────────────────────
function ItemEditor({ item, perItem, onDone, onCancel, onDelete, onReword }: {
  item: QuoteItemV2; perItem: boolean;
  onDone: (patch: Partial<QuoteItemV2>) => void; onCancel: () => void;
  onDelete: () => void; onReword: () => Promise<Suggestion[]>;
}) {
  const [d, setD] = useState({
    name: item.name, description: item.description,
    quantity: formatQty(item.quantity), unit: item.unit, unit_price: item.unit_price ? String(item.unit_price) : "",
  });
  const [ai, setAi] = useState<{ state: "idle" | "loading" | "error" } | { state: "ready"; options: Suggestion[] }>({ state: "idle" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reword = async () => {
    setAi({ state: "loading" });
    try {
      const options = (await onReword()).filter((o) => o?.name);
      setAi(options.length ? { state: "ready", options } : { state: "error" });
    } catch {
      setAi({ state: "error" });
    }
  };
  const parse = (s: string) => parseFloat(s.replace(/,/g, "")) || 0;
  const done = () => {
    if (!d.name.trim() && !item.name.trim()) { onCancel(); return; } // new item left without a name
    save();
  };
  const save = () => onDone({
    name: d.name.trim() || item.name,
    description: d.description,
    ...(perItem ? { quantity: parse(d.quantity) || 1, unit: d.unit, unit_price: parse(d.unit_price) } : {}),
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "#faf5ff", padding: 10, borderRadius: 8 }}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) done(); }}>
      <input autoFocus aria-label="שם הפריט" placeholder="שם הפריט" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} style={inputStyle} />
      <textarea aria-label="תיאור" value={d.description} placeholder="תיאור (לא חובה)" rows={2} onChange={(e) => setD({ ...d, description: e.target.value })} style={{ ...inputStyle, resize: "vertical" }} />
      {ai.state === "ready" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12, color: "#6b7280" }}>בחר ניסוח:</div>
          {ai.options.map((o, k) => (
            <button key={k} onClick={() => { setD({ ...d, name: o.name, description: o.description ?? "" }); setAi({ state: "idle" }); }}
              style={{ textAlign: "right", padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd6fe", background: "#fff", cursor: "pointer", fontFamily: "inherit", color: "#1a1a2e" }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{o.name}</div>
              {o.description && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{o.description}</div>}
            </button>
          ))}
          <button onClick={() => setAi({ state: "idle" })} style={{ ...chipStyle, alignSelf: "flex-start", fontSize: 12, padding: "4px 12px" }}>השאר כמו שהיה</button>
        </div>
      ) : (
        <button onClick={reword} disabled={ai.state === "loading"} style={{ ...chipStyle, alignSelf: "flex-start", fontSize: 12, padding: "5px 12px", background: "#faf5ff", border: "1px dashed #c4b5fd" }}>
          {ai.state === "loading" ? <>מנסח <Dots /></> : ai.state === "error" ? "✨ לא הצלחתי — נסה שוב" : "✨ שפר ניסוח"}
        </button>
      )}
      {perItem && (
        <div style={{ display: "flex", gap: 6 }}>
          <input aria-label="כמות" inputMode="decimal" value={d.quantity} onChange={(e) => setD({ ...d, quantity: e.target.value })} style={{ ...inputStyle, width: 64 }} />
          <select aria-label="יחידה" value={d.unit} onChange={(e) => setD({ ...d, unit: e.target.value })} style={{ ...inputStyle, width: 80 }}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <input aria-label="מחיר ליחידה" inputMode="decimal" placeholder="מחיר ליחידה" value={d.unit_price} onChange={(e) => setD({ ...d, unit_price: e.target.value })} style={{ ...inputStyle, flex: 1 }} />
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={done} style={{ ...chipStyle, background: PURPLE, color: "#fff", border: "none" }}>שמירה</button>
        <button onClick={onCancel} style={chipStyle}>ביטול</button>
        <button
          onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
          style={{ ...chipStyle, marginInlineStart: "auto", border: "none", background: confirmDelete ? "#dc2626" : "transparent", color: confirmDelete ? "#fff" : "#dc2626" }}
        >{confirmDelete ? "למחוק? לחץ שוב" : "מחיקת פריט"}</button>
      </div>
    </div>
  );
}

// ── Small pieces ──────────────────────────────────────────────────────────────
function Editable({ value, placeholder, onChange, multiline, style }: {
  value: string; placeholder: string; onChange: (v: string) => void; multiline?: boolean; style?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const commit = () => { setEditing(false); if (draft !== value) onChange(draft.trim()); };
  if (editing) {
    const common = {
      autoFocus: true, value: draft, "aria-label": placeholder,
      onBlur: commit,
      style: { ...inputStyle, ...style },
    };
    return multiline
      ? <textarea {...common} rows={3} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }} />
      : <input {...common} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }} />;
  }
  return (
    <button
      onClick={() => { setDraft(value); setEditing(true); }}
      style={{ display: "block", width: "100%", textAlign: "right", background: "none", border: "none", padding: "3px 0", cursor: "text", fontFamily: "inherit", whiteSpace: "pre-wrap", lineHeight: 1.6, color: value ? "#111827" : "#a78bfa", ...style, ...(value ? {} : { color: "#a78bfa" }) }}
    >{value || placeholder}</button>
  );
}

function NumberEdit({ value, onChange, render }: { value: number; onChange: (n: number) => void; render: (n: number) => string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (editing) {
    const commit = () => { setEditing(false); const n = parseFloat(draft.replace(/,/g, "")); onChange(Number.isFinite(n) && n > 0 ? n : 0); };
    return <input autoFocus inputMode="decimal" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
      style={{ ...inputStyle, width: 110, textAlign: "left" }} />;
  }
  return <button onClick={() => { setDraft(value ? String(value) : ""); setEditing(true); }}
    style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", fontWeight: "inherit", color: value ? "inherit" : "#a78bfa", padding: 0 }}>{render(value)}</button>;
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", fontWeight: strong ? 800 : 400, fontSize: strong ? 17 : 13, color: strong ? PURPLE : "#374151" }}>
      <span style={{ fontSize: strong ? 13 : 13, fontWeight: strong ? 700 : 400 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ margin: "12px 0", padding: "10px 12px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

/** 📷 Site photos: thumbnails, add (camera or gallery), remove (tap twice). */
function PhotosBox({ images, onAdd, onRemove, busy }: { images: string[]; onAdd: (f: File[]) => void; onRemove: (url: string) => void; busy: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const working = !!busy && busy.endsWith("...");
  return (
    <Box title="📷 תמונות מהשטח">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
        {images.map((url) => (
          <div key={url} style={{ position: "relative", width: 76, height: 76 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" style={{ width: 76, height: 76, objectFit: "cover", borderRadius: 10, border: "1px solid #e5e7eb" }} />
            <button
              onClick={() => (armed === url ? (onRemove(url), setArmed(null)) : setArmed(url))}
              aria-label="הסרת תמונה"
              style={{
                position: "absolute", top: 4, insetInlineEnd: 4, height: 22, minWidth: 22, padding: armed === url ? "0 6px" : 0, borderRadius: 11, border: "none",
                background: armed === url ? "#dc2626" : "rgba(0,0,0,0.55)", color: "#fff", fontSize: armed === url ? 10 : 13, cursor: "pointer", fontFamily: "inherit",
              }}
            >{armed === url ? "להסיר?" : "×"}</button>
          </div>
        ))}
        {images.length < MAX_PHOTOS && (
          <button onClick={() => fileRef.current?.click()} disabled={working} aria-label="הוספת תמונות" style={{
            width: 76, height: 76, borderRadius: 10, border: "1.5px dashed #c4b5fd", background: "#faf5ff", color: PURPLE,
            cursor: working ? "default" : "pointer", fontFamily: "inherit", fontSize: 12, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
          }}>
            <span style={{ fontSize: 22 }}>📷</span>הוספה
          </button>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) onAdd(fs); }} />
      {busy ? (
        <div style={{ fontSize: 12, color: working ? PURPLE : "#b45309", marginTop: 6 }}>{busy}</div>
      ) : !images.length ? (
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>יופיעו ב-PDF ובעמוד ההצעה. ✨ ה-AI יציע פריטים לפי מה שרואים בתמונה.</div>
      ) : null}
    </Box>
  );
}

/** "✨ הצעות" under notes / terms: loads 3-4 lines, the user ticks what to add. */
function AiLines({ load, onAdd }: { load: () => Promise<{ text: string }[]>; onAdd: (lines: string[]) => void }) {
  const [st, setSt] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [options, setOptions] = useState<string[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const open = async () => {
    setSt("loading");
    try {
      const lines = (await load()).map((o) => o?.text?.trim()).filter((s): s is string => !!s);
      setOptions(lines);
      setPicked([]);
      setSt(lines.length ? "ready" : "error");
    } catch {
      setSt("error");
    }
  };
  if (st !== "ready") {
    return (
      <button onClick={open} disabled={st === "loading"} style={{ ...chipStyle, marginTop: 6, fontSize: 12, padding: "4px 12px", background: "#faf5ff", border: "1px dashed #c4b5fd" }}>
        {st === "loading" ? <>מחפש הצעות <Dots /></> : st === "error" ? "✨ לא הצלחתי — נסה שוב" : "✨ הוסף עם AI"}
      </button>
    );
  }
  return (
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
      {options.map((line, k) => (
        <label key={k} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#1a1a2e", padding: "6px 8px", borderRadius: 8, background: picked.includes(k) ? "#ede9fe" : "#fff", border: "1px solid #ede9fe", cursor: "pointer" }}>
          <input type="checkbox" checked={picked.includes(k)} onChange={() => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]))} style={{ accentColor: PURPLE, marginTop: 3 }} />
          <span>{line}</span>
        </label>
      ))}
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button disabled={!picked.length} onClick={() => { onAdd(picked.sort((a, b) => a - b).map((k) => options[k])); setSt("idle"); }}
          style={{ ...chipStyle, fontSize: 12, padding: "5px 14px", background: picked.length ? PURPLE : "#e5e7eb", color: picked.length ? "#fff" : "#9ca3af", border: "none" }}>
          הוספה{picked.length ? ` (${picked.length})` : ""}
        </button>
        <button onClick={() => setSt("idle")} style={{ ...chipStyle, fontSize: 12, padding: "5px 14px" }}>ביטול</button>
      </div>
    </div>
  );
}

function Dots({ light }: { light?: boolean }) {
  return (
    <span aria-label="חושב" style={{ display: "inline-flex", gap: 4 }}>
      <style>{`@keyframes v2dot{0%,100%{opacity:.2}50%{opacity:1}}`}</style>
      {[0, 1, 2].map((i) => <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: light ? "#fff" : PURPLE, animation: `v2dot 1.2s ${i * 0.2}s infinite` }} />)}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", fontSize: 13, color: "#1a1a2e", border: "1px solid #c4b5fd", borderRadius: 6, padding: "6px 8px",
  outline: "none", fontFamily: "inherit", direction: "rtl", background: "#fff", boxSizing: "border-box",
};

const roundBtn: React.CSSProperties = {
  flexShrink: 0, width: 34, height: 34, borderRadius: "50%", cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
};

const chipStyle: React.CSSProperties = {
  padding: "7px 16px", borderRadius: 20, border: "1px solid #e0e0e0", background: "#fff",
  color: "#6d28d9", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
};
