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
  loading?: boolean;
  error?: boolean;
}

type Q = Partial<QuoteV2>;
type SaveState = "idle" | "saving" | "saved" | "error";

interface Props {
  aiContext: AIContext;
  token: string;
  bubbleEnv: "test" | "live";
}

const PURPLE = "#7c3aed";
const PURPLE_2 = "#a855f7";
const PURPLE_LIGHT = "#7c3aed26";

// ── Draft persistence (survives a refresh of the Bubble iframe) ───────────────
const draftKey = (userId?: string) => `quote_v2_draft:${userId ?? "anon"}`;
function loadDraft(userId?: string): { messages: ChatMessage[]; quote: Q } | null {
  try {
    const raw = localStorage.getItem(draftKey(userId));
    if (!raw) return null;
    const d = JSON.parse(raw) as { messages: ChatMessage[]; quote: Q; at: number };
    if (Date.now() - d.at > 3 * 24 * 3600 * 1000) return null; // older than 3 days
    return { messages: d.messages.filter((m) => !m.loading), quote: d.quote };
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

  const [isMobile, setIsMobile] = useState(false);
  const [mobileView, setMobileView] = useState<"chat" | "preview">("chat");
  const [unseenUpdate, setUnseenUpdate] = useState(false);

  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [voice, setVoice] = useState<"idle" | "recording" | "transcribing">("idle");
  const [recSeconds, setRecSeconds] = useState(0);

  // Restore a draft once on mount
  useEffect(() => {
    const d = loadDraft(aiContext.user_id);
    if (d && (d.quote.items?.length || d.quote.title)) {
      setMessages(d.messages.length ? d.messages : [{ role: "assistant", content: greeting }]);
      setQuote(d.quote);
      setRestored(true);
    }
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
  }, [messages]);

  const hasQuote = (quote.items?.length ?? 0) > 0 || !!quote.title;

  // ── Send to AI ──────────────────────────────────────────────────────────────
  const send = useCallback(async (text: string) => {
    const userText = text.trim();
    if (!userText || isLoading) return;
    const history = [...messages.filter((m) => !m.loading && !m.error), { role: "user" as const, content: userText }];
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
        const first = !(quote.items?.length);
        setQuote((prev) => mergeQuoteV2(prev, data.quote!));
        // Mobile: jump to the preview only for the first draft; later just flag it
        if (first) setMobileView("preview");
        else setUnseenUpdate(true);
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
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    send(t);
  }, [input, send]);

  // ── Voice: record (MediaRecorder) → /api/v2/transcribe → send as a message ──
  // Same approach as the Bubble voice_test page, which worked on desktop, mobile and the app.
  const MAX_REC_SEC = 180;
  const handleVoice = useCallback(async () => {
    if (voice === "transcribing" || isLoading) return;
    if (voice === "recording") { recorderRef.current?.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      alert("ההקלטה לא נתמכת בדפדפן הזה — אפשר להקליד");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "אין גישה למיקרופון — צריך לאשר הרשאה בדפדפן.", error: true }]);
      return;
    }
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    const type = types.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
    const rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    const used = rec.mimeType || type || "audio/mp4";
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      if (timerRef.current) clearInterval(timerRef.current);
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: used });
      if (blob.size < 1000) { setVoice("idle"); return; }
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
        const msg = e instanceof Error && e.message === "no_speech" ? "לא שמעתי דיבור בהקלטה — נסה שוב" : "התמלול נכשל — נסה שוב או הקלד";
        setMessages((prev) => [...prev, { role: "assistant", content: msg, error: true }]);
      }
    };
    recorderRef.current = rec;
    rec.start();
    setRecSeconds(0);
    setVoice("recording");
    const t0 = Date.now();
    timerRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setRecSeconds(s);
      if (s >= MAX_REC_SEC && rec.state === "recording") rec.stop();
    }, 250);
  }, [voice, isLoading, token, send]);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  // ── Manual edits ────────────────────────────────────────────────────────────
  const edit = useCallback((patch: Q) => setQuote((prev) => ({ ...prev, ...patch })), []);
  const editClient = useCallback((patch: Partial<QuoteV2["client"]>) =>
    setQuote((prev) => ({ ...prev, client: { ...(prev.client ?? {}), ...patch } })), []);
  const setItems = useCallback((fn: (items: QuoteItemV2[]) => QuoteItemV2[]) =>
    setQuote((prev) => ({ ...prev, items: fn(prev.items ?? []) })), []);

  const startOver = useCallback(() => {
    if (!confirm("להתחיל הצעה חדשה? הטיוטה הנוכחית תימחק.")) return;
    clearDraft(aiContext.user_id);
    setQuote({});
    setMessages([{ role: "assistant", content: greeting }]);
    setRestored(false);
    setSaveState("idle");
    setMobileView("chat");
  }, [aiContext.user_id, greeting]);

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
  const showPanel = hasQuote && (!isMobile || mobileView === "preview");
  const showChat = !isMobile || !hasQuote || mobileView === "chat";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#fff", overflow: "hidden" }}>
      {isMobile && hasQuote && (
        <div dir="rtl" style={{ flexShrink: 0, padding: "8px 14px", borderBottom: "1px solid #e8eaed", display: "flex", gap: 8 }}>
          <TabButton active={mobileView === "chat"} onClick={() => setMobileView("chat")}>💬 שיחה</TabButton>
          <TabButton active={mobileView === "preview"} onClick={() => { setMobileView("preview"); setUnseenUpdate(false); }}>
            📋 ההצעה{unseenUpdate && <span style={{ marginInlineStart: 6, background: "#ec4899", color: "#fff", borderRadius: 10, padding: "0 7px", fontSize: 11 }}>עודכן</span>}
          </TabButton>
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0, direction: "ltr" }}>
        {/* LEFT: quote panel */}
        {showPanel && (
          <div style={{ width: isMobile ? "100%" : "46%", minWidth: isMobile ? 0 : 340, borderRight: isMobile ? "none" : "1px solid #e5e7eb", display: "flex", flexDirection: "column", minHeight: 0 }}>
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
            />
          </div>
        )}

        {/* RIGHT: chat */}
        {showChat && (
          <div dir="rtl" style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, color: "#1a1a2e" }}>
            <div style={{ padding: "12px 18px", borderBottom: "1px solid #e8eaed", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{aiContext.company_name}</div>
                <div style={{ fontSize: 12, color: "#6d28d9", marginTop: 2 }}>
                  הצעת מחיר עם AI{bubbleEnv === "test" && <span style={{ color: "#dc2626" }}> · מצב בדיקה (version-test)</span>}
                </div>
              </div>
              {hasQuote && (
                <button onClick={startOver} style={{ ...chipStyle, fontSize: 12, padding: "6px 12px" }}>הצעה חדשה</button>
              )}
            </div>

            <div ref={messagesRef} style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
              {restored && (
                <div style={{ alignSelf: "center", fontSize: 12, color: "#6b7280", background: "#f3f4f6", borderRadius: 12, padding: "4px 12px" }}>
                  שחזרנו את הטיוטה האחרונה שלך
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-start" : "flex-end" }}>
                  <div aria-live={m.role === "assistant" ? "polite" : undefined} style={{
                    maxWidth: "85%", padding: "10px 16px", borderRadius: 18, fontSize: 15, lineHeight: 1.7,
                    wordBreak: "break-word", whiteSpace: "pre-wrap",
                    background: m.role === "user" ? "#eef1ff" : m.error ? "#fef2f2" : "#f5f0ff",
                    color: m.error ? "#b91c1c" : "#1a1a2e",
                  }}>
                    {m.loading ? <Dots /> : m.content}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ padding: "8px 14px 14px" }}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8, border: "1px solid #e2e6ea", borderRadius: 26, padding: "8px 12px", boxShadow: "0 1px 8px rgba(0,0,0,0.07)" }}>
                <button
                  onClick={handleVoice}
                  disabled={voice === "transcribing" || isLoading}
                  aria-label={voice === "recording" ? "עצור ושלח" : "הקלטה במקום הקלדה"}
                  style={{ ...roundBtn, border: voice === "recording" ? "none" : "1px solid #e2e6ea", background: voice === "recording" ? "#dc2626" : "transparent", color: voice === "recording" ? "#fff" : "#6d28d9" }}
                >{voice === "recording" ? "■" : "🎙"}</button>
                {voice !== "idle" ? (
                  <button
                    onClick={handleVoice}
                    disabled={voice === "transcribing"}
                    style={{ flex: 1, minHeight: 34, border: "none", background: "transparent", textAlign: "right", fontFamily: "inherit", fontSize: 15, cursor: voice === "recording" ? "pointer" : "default", color: voice === "recording" ? "#dc2626" : "#6d28d9", display: "flex", alignItems: "center", gap: 8 }}
                  >
                    {voice === "recording"
                      ? <>● מקליט {String(Math.floor(recSeconds / 60)).padStart(2, "0")}:{String(recSeconds % 60).padStart(2, "0")} — לחץ לעצירה ושליחה</>
                      : <>מתמלל... <Dots /></>}
                  </button>
                ) : (
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; }}
                  placeholder={hasQuote ? "מה לשנות? למשל: תוסיף פינוי פסולת 500" : "למשל: ריצוף 20 מ\"ר ב-250 למ\"ר ופירוק 1500, לדני כהן בהרצל 5"}
                  rows={1}
                  disabled={isLoading}
                  style={{ flex: 1, border: "none", outline: "none", resize: "none", fontSize: 16, lineHeight: 1.5, maxHeight: 140, direction: "rtl", fontFamily: "inherit", background: "transparent", color: "#1a1a2e" }}
                />
                )}
                <button
                  onClick={handleSend}
                  onMouseDown={(e) => e.preventDefault()}
                  disabled={isLoading || !input.trim()}
                  aria-label="שלח"
                  style={{ ...roundBtn, border: "none", background: input.trim() && !isLoading ? `linear-gradient(135deg, ${PURPLE}, #6d28d9)` : "#e8eaed", color: input.trim() && !isLoading ? "#fff" : "#9ca3af" }}
                >←</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Quote panel ───────────────────────────────────────────────────────────────
function QuotePanelV2({
  quote, companyName, companyLogo, onEdit, onEditClient, onSetItems, onSwitchMode, onSave, saveState, saveError, isTest,
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
  const moveItem = (i: number, d: -1 | 1) =>
    onSetItems((list) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

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
        <div style={{ marginBottom: 8 }}>
          {items.map((it, i) => (
            <div key={i} style={{ padding: "10px 0", borderBottom: "1px solid #f3f4f6" }}>
              {editingIdx === i ? (
                <ItemEditor
                  item={it}
                  perItem={perItem}
                  onDone={(patch) => { updateItem(i, patch); setEditingIdx(null); }}
                  onCancel={() => setEditingIdx(null)}
                />
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: "50%", background: PURPLE_LIGHT, color: PURPLE, fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                  <button onClick={() => setEditingIdx(i)} style={{ flex: 1, minWidth: 0, textAlign: "right", background: "none", border: "none", padding: 0, cursor: "text", fontFamily: "inherit", color: "inherit" }} aria-label={`עריכת פריט ${i + 1}`}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{it.name}</div>
                    {it.description && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2, lineHeight: 1.5 }}>{it.description}</div>}
                    {perItem && (
                      <div style={{ fontSize: 12, color: "#4b5563", marginTop: 4, display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span>{formatQty(it.quantity)} {it.unit} × {it.unit_price ? formatILS(it.unit_price) : <span style={{ color: "#d97706" }}>חסר מחיר</span>}</span>
                        <span style={{ fontWeight: 700, color: "#111827" }}>{formatILS(lineTotal(it))}</span>
                      </div>
                    )}
                  </button>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <SmallBtn label="למעלה" onClick={() => moveItem(i, -1)} disabled={i === 0}>▲</SmallBtn>
                    <SmallBtn label="למטה" onClick={() => moveItem(i, 1)} disabled={i === items.length - 1}>▼</SmallBtn>
                  </div>
                  <SmallBtn label="מחיקת פריט" danger onClick={() => onSetItems((list) => list.filter((_, j) => j !== i))}>×</SmallBtn>
                </div>
              )}
            </div>
          ))}
          <button
            onClick={() => { onSetItems((list) => [...list, normalizeItem({ name: "פריט חדש", unit: DEFAULT_UNIT })]); setEditingIdx(items.length); }}
            style={{ ...chipStyle, marginTop: 10, fontSize: 13 }}
          >+ הוספת פריט</button>
        </div>

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
            <Row
              label="סה״כ לתשלום"
              strong
              value={<NumberEdit value={quote.total ?? 0} onChange={(n) => onEdit({ total: n })} render={(n) => (n ? formatILS(n) : "עדכון מחיר ✏️")} />}
            />
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: "#4b5563", cursor: "pointer" }}>
            <input type="checkbox" checked={!!quote.has_tax} onChange={(e) => onEdit({ has_tax: e.target.checked })} style={{ accentColor: PURPLE }} />
            {perItem ? "להוסיף מע״מ 18%" : "המחיר כולל מע״מ"}
          </label>
        </div>

        <Box title="תנאים ואחריות">
          <Editable multiline value={[quote.warranty, quote.terms].filter(Boolean).join("\n")} placeholder="הוספת תנאים ✏️" onChange={(v) => onEdit({ terms: v, warranty: "" })} style={{ fontSize: 12, color: "#4b5563" }} />
        </Box>
        <Box title="הערות">
          <Editable multiline value={quote.comments ?? ""} placeholder="הוספת הערות ✏️" onChange={(v) => onEdit({ comments: v })} style={{ fontSize: 12, color: "#4b5563" }} />
        </Box>
        <div style={{ height: 90 }} />
      </div>

      {/* Save */}
      <div style={{ position: "sticky", bottom: 0, background: "linear-gradient(to top, #fff 75%, transparent)", padding: "14px 18px 18px", textAlign: "center" }}>
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
function ItemEditor({ item, perItem, onDone, onCancel }: {
  item: QuoteItemV2; perItem: boolean;
  onDone: (patch: Partial<QuoteItemV2>) => void; onCancel: () => void;
}) {
  const [d, setD] = useState({
    name: item.name, description: item.description,
    quantity: formatQty(item.quantity), unit: item.unit, unit_price: item.unit_price ? String(item.unit_price) : "",
  });
  const parse = (s: string) => parseFloat(s.replace(/,/g, "")) || 0;
  const done = () => onDone({
    name: d.name.trim() || item.name,
    description: d.description,
    ...(perItem ? { quantity: parse(d.quantity) || 1, unit: d.unit, unit_price: parse(d.unit_price) } : {}),
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "#faf5ff", padding: 10, borderRadius: 8 }}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) done(); }}>
      <input autoFocus aria-label="שם הפריט" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} style={inputStyle} />
      <textarea aria-label="תיאור" value={d.description} placeholder="תיאור (לא חובה)" rows={2} onChange={(e) => setD({ ...d, description: e.target.value })} style={{ ...inputStyle, resize: "vertical" }} />
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

function SmallBtn({ children, onClick, label, disabled, danger }: { children: React.ReactNode; onClick: () => void; label: string; disabled?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} title={label} style={{
      width: 22, height: 20, borderRadius: 6, padding: 0, fontSize: 11, lineHeight: 1, cursor: disabled ? "default" : "pointer",
      border: danger ? "1px solid #fca5a5" : "1px solid #e5e7eb", background: "#fff",
      color: danger ? "#ef4444" : "#6b7280", opacity: disabled ? 0.3 : 1,
    }}>{children}</button>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: "9px 0", borderRadius: 20, fontSize: 14, fontWeight: 700, cursor: "pointer",
      border: active ? "none" : "1px solid #e5e7eb",
      background: active ? `linear-gradient(135deg, ${PURPLE}, ${PURPLE_2})` : "#fff",
      color: active ? "#fff" : "#4b5563",
    }}>{children}</button>
  );
}

function Dots() {
  return (
    <span aria-label="חושב" style={{ display: "inline-flex", gap: 4 }}>
      <style>{`@keyframes v2dot{0%,100%{opacity:.2}50%{opacity:1}}`}</style>
      {[0, 1, 2].map((i) => <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: PURPLE, animation: `v2dot 1.2s ${i * 0.2}s infinite` }} />)}
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
