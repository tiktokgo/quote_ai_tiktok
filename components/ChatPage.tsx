"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { AIContext } from "@/lib/verifyToken";
import type { Quote, PartialQuote } from "@/lib/quoteSchema";

// ── Loader animation ──────────────────────────────────────────────────────────
function QuoteLoader() {
  return (
    <>
      <style>{`
        @keyframes ql-dot {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          40%, 60%  { opacity: 1;   transform: scale(1.2); }
        }
        .ql-d  { animation: ql-dot 1.4s ease-in-out infinite; border-radius: 50%; width: 8px; height: 8px; background: rgba(139,92,246,0.8); display: inline-block; margin: 0 3px; }
        .ql-d1 { animation-delay: 0s; }
        .ql-d2 { animation-delay: 0.22s; }
        .ql-d3 { animation-delay: 0.44s; }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", padding: "6px 0" }}>
        <span className="ql-d ql-d1" />
        <span className="ql-d ql-d2" />
        <span className="ql-d ql-d3" />
      </div>
    </>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  loading?: boolean;
}

interface ChatPageProps {
  aiContext?: AIContext & { user_id?: string };
  isGuest?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatILS(n: number): string {
  return new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ChatPage({ aiContext, isGuest }: ChatPageProps) {
  const [messages, setMessages]   = useState<ChatMessage[]>([]);
  const [input, setInput]         = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [quote, setQuote]         = useState<Partial<Quote>>({});

  // ── Guest state ───────────────────────────────────────────────────────────
  const [guestInfo, setGuestInfo] = useState<{ company_name: string; email: string; industry: string } | null>(null);
  const [guestDraft, setGuestDraft] = useState({ company_name: "", email: "", industry: "" });

  const effectiveContext: (AIContext & { user_id?: string }) | undefined =
    aiContext ?? (guestInfo ? {
      company_name: guestInfo.company_name,
      industry:     guestInfo.industry,
      company_info: `אימייל: ${guestInfo.email}`,
    } : undefined);

  // ── Mobile state ──────────────────────────────────────────────────────────
  const [isMobile, setIsMobile] = useState(false);
  const isMobileRef = useRef(false);
  const [mobileView, setMobileView] = useState<"chat" | "preview">("chat");

  useEffect(() => {
    const check = () => {
      const mobile = window.innerWidth < 768;
      isMobileRef.current = mobile;
      setIsMobile(mobile);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const bottomRef    = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null); // improve quote
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [isListening, setIsListening] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!effectiveContext) return;
    const greeting = effectiveContext.user_name
      ? `שלום ${effectiveContext.user_name}! אני עוזר הצעות המחיר שלך עבור ${effectiveContext.company_name}. ספר לי על העבודה ואני אבנה הצעת מחיר מיד.`
      : `אני עוזר הצעות המחיר שלך עבור ${effectiveContext.company_name}. ספר לי על העבודה ואני אבנה הצעת מחיר מיד.`;
    setMessages([{ role: "assistant", content: greeting }]);
  }, [aiContext, guestInfo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Send ──────────────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (userText: string, currentQuote: Partial<Quote>) => {
    if (!userText.trim()) return;

    setMessages((prev) => [
      ...prev,
      { role: "user", content: userText },
      { role: "assistant", content: "", loading: true },
    ]);
    setIsLoading(true);

    try {
      const historyForApi = [
        ...messages.filter((m) => !m.loading),
        { role: "user" as const, content: userText },
      ].map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historyForApi, aiContext: effectiveContext, currentQuote }),
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string; content?: string; quote?: PartialQuote;
            };
            if (event.type === "text" && event.content) {
              assistantText += event.content + " ";
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                  updated[updated.length - 1] = { ...last, content: assistantText.trim(), loading: false };
                }
                return updated;
              });
            } else if (event.type === "quote_update" && event.quote) {
              setQuote((prev) => mergeQuote(prev, event.quote!));
              if (isMobileRef.current) setMobileView("preview");
            } else if (event.type === "done") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant" && last.loading) {
                  updated[updated.length - 1] = { ...last, loading: false };
                }
                return updated;
              });
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = { ...last, content: `שגיאה: ${msg}`, loading: false };
        }
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  }, [messages, aiContext]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    sendMessage(text, quote);
  }, [input, isLoading, quote, sendMessage]);

  // ── PDF: Improve quote ────────────────────────────────────────────────────
  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    setMessages((prev) => [...prev, { role: "user", content: `📄 ${file.name}` }]);
    setIsLoading(true);
    setMessages((prev) => [...prev, { role: "assistant", content: "", loading: true }]);

    try {
      const fd = new FormData();
      fd.append("file", file);
      const parseRes = await fetch("/api/parse-pdf", { method: "POST", body: fd });
      if (!parseRes.ok) throw new Error(`HTTP ${parseRes.status}`);
      const { text } = await parseRes.json() as { text: string };
      setIsLoading(false);
      setMessages((prev) => prev.filter((m) => !m.loading));
      const prompt = `שפר את ההצעה הבאה — הוסף את כל הפריטים הסטנדרטיים החסרים, שפר את התיאורים, ושדרג אחריות ותנאים. תוכן ה-PDF:\n\n${text}`;
      await sendMessage(prompt, quote);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setIsLoading(false);
      setMessages((prev) => {
        const updated = prev.filter((m) => !m.loading);
        return [...updated, { role: "assistant", content: `שגיאה בקריאת ה-PDF: ${msg}` }];
      });
    }
  }, [quote, sendMessage]);

  // ── Voice ─────────────────────────────────────────────────────────────────
  const handleVoice = useCallback(() => {
    if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
      alert("הדפדפן שלך אינו תומך בזיהוי קול");
      return;
    }
    if (isListening) { recognitionRef.current?.stop(); return; }
    const SR = (window as unknown as { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition
            ?? (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "he-IL";
    rec.interimResults = false;
    rec.onstart  = () => setIsListening(true);
    rec.onend    = () => setIsListening(false);
    rec.onerror  = () => setIsListening(false);
    rec.onresult = (e: SpeechRecognitionEvent) => {
      const t = e.results[0]?.[0]?.transcript ?? "";
      if (t) setInput((prev) => prev ? prev + " " + t : t);
    };
    recognitionRef.current = rec;
    rec.start();
  }, [isListening]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  const hasQuote = (quote.items?.length ?? 0) > 0 || !!quote.title;

  // ── Manual quote edits ────────────────────────────────────────────────────
  const handleTitleChange = useCallback((title: string) => {
    setQuote((prev) => ({ ...prev, title }));
  }, []);

  const handleDeleteItem = useCallback((index: number) => {
    setQuote((prev) => ({ ...prev, items: prev.items?.filter((_, i) => i !== index) }));
  }, []);

  const handleUpdateItem = useCallback((index: number, name: string, description: string) => {
    setQuote((prev) => {
      const items = [...(prev.items ?? [])];
      items[index] = { ...items[index], name, description };
      return { ...prev, items };
    });
  }, []);

  const handleUpdateTerms = useCallback((terms: string) => {
    setQuote((prev) => ({ ...prev, terms, warranty: "" }));
  }, []);

  const handleUpdateComments = useCallback((comments: string) => {
    setQuote((prev) => ({ ...prev, comments }));
  }, []);

  // ── Approve quote → send full quote to Bubble ─────────────────────────────
  const [approveState, setApproveState] = useState<"idle" | "loading" | "success" | "reviewing" | "submitted" | "error">("idle");
  const [quoteId, setQuoteId] = useState<string | undefined>();
  const [reviewStars, setReviewStars] = useState(0);
  const [reviewComment, setReviewComment] = useState("");

  const handleApprove = useCallback(async () => {
    setApproveState("loading");
    try {
      let res: Response;
      if (isGuest && guestInfo) {
        res = await fetch("/api/onboard-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            company_name: guestInfo.company_name,
            email:        guestInfo.email,
            industry:     guestInfo.industry,
            quote,
          }),
        });
      } else {
        res = await fetch("/api/approve-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: aiContext?.user_id, quote }),
        });
      }
      const data = await res.json() as { ok: boolean; quote_id?: string };
      if (data.ok) {
        if (data.quote_id) setQuoteId(data.quote_id);
        setApproveState("success");
        setTimeout(() => setApproveState("reviewing"), 2200);
      } else {
        setApproveState("error");
        setTimeout(() => setApproveState("idle"), 3000);
      }
    } catch {
      setApproveState("error");
      setTimeout(() => setApproveState("idle"), 3000);
    }
  }, [aiContext, isGuest, guestInfo, quote]);

  const doRedirect = useCallback((id: string | undefined) => {
    const base = process.env.NEXT_PUBLIC_REDIRECT_BASE ?? "";
    if (base && id) window.location.href = base + id;
  }, []);

  const handleReviewSubmit = useCallback(async () => {
    setApproveState("submitted");
    try {
      await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quote_id: quoteId, stars: reviewStars, comment: reviewComment, user_id: aiContext?.user_id }),
      });
    } catch { /* fire and forget */ }
    setTimeout(() => doRedirect(quoteId), 1500);
  }, [quoteId, reviewStars, reviewComment, aiContext, doRedirect]);

  const handleSkipReview = useCallback(() => {
    setApproveState("submitted");
    setTimeout(() => doRedirect(quoteId), 1500);
  }, [quoteId, doRedirect]);

  // ── Guest form (no token) ──────────────────────────────────────────────────
  if (isGuest && !guestInfo) {
    const canSubmit = guestDraft.company_name.trim() && guestDraft.email.trim() && guestDraft.industry.trim();
    return (
      <div dir="rtl" style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "100dvh", fontFamily: "'Segoe UI', Arial, sans-serif",
        background: "linear-gradient(180deg, #07071a 0%, #0b0920 50%, #0f0c28 100%)",
      }}>
        <div style={{
          width: "100%", maxWidth: 420, margin: "0 16px",
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(139,92,246,0.25)",
          borderRadius: 16, padding: "36px 28px",
        }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ fontSize: "28px", marginBottom: 8 }}>✨</div>
            <div style={{ fontSize: "20px", fontWeight: 800, color: "#c4b5fd" }}>יוצר הצעות מחיר</div>
            <div style={{ fontSize: "13px", color: "rgba(196,181,253,0.6)", marginTop: 6 }}>מלא את הפרטים ונתחיל</div>
          </div>
          {(["company_name", "email", "industry"] as const).map((field) => (
            <div key={field} style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: "12px", color: "#a78bfa", marginBottom: 6, fontWeight: 600 }}>
                {field === "company_name" ? "שם חברה" : field === "email" ? "אימייל" : "תחום עיסוק"}
              </label>
              <input
                type={field === "email" ? "email" : "text"}
                value={guestDraft[field]}
                onChange={(e) => setGuestDraft((p) => ({ ...p, [field]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) setGuestInfo({ ...guestDraft }); }}
                placeholder={field === "company_name" ? "למשל: אינסטלציה כהן" : field === "email" ? "your@email.com" : "למשל: אינסטלציה"}
                style={{
                  width: "100%", padding: "10px 12px", borderRadius: 8, boxSizing: "border-box",
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(139,92,246,0.3)",
                  color: "#e2e8f0", fontSize: "14px", outline: "none", direction: "rtl",
                  fontFamily: "inherit",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "#a78bfa")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(139,92,246,0.3)")}
              />
            </div>
          ))}
          <button
            onClick={() => { if (canSubmit) setGuestInfo({ ...guestDraft }); }}
            disabled={!canSubmit}
            style={{
              marginTop: 8, width: "100%", padding: "13px 0", borderRadius: 50, border: "none",
              background: canSubmit
                ? "linear-gradient(135deg, #7c3aed 0%, #a855f7 60%, #ec4899 100%)"
                : "rgba(139,92,246,0.2)",
              color: "#fff", fontSize: "15px", fontWeight: 700, cursor: canSubmit ? "pointer" : "default",
              boxShadow: canSubmit ? "0 4px 24px rgba(139,92,246,0.45)" : "none",
              transition: "background 0.2s, box-shadow 0.2s",
            }}
          >
            התחל בניית הצעת מחיר ←
          </button>
        </div>
      </div>
    );
  }

  return (
    // Outer: column flex — tab bar on top (mobile), panels row below
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100dvh",
      fontFamily: "'Segoe UI', Arial, sans-serif",
      background: "linear-gradient(180deg, #07071a 0%, #0b0920 50%, #0f0c28 100%)",
      overflow: "hidden",
    }}>

      {/* ── Mobile tab bar ────────────────────────────────────────────────── */}
      {isMobile && hasQuote && (
        <div dir="rtl" style={{
          display: "flex",
          flexShrink: 0,
          height: 48,
          background: "rgba(7,7,26,0.97)",
          borderBottom: "1px solid rgba(139,92,246,0.3)",
          zIndex: 40,
        }}>
          {(["chat", "preview"] as const).map((view) => (
            <button key={view} onClick={() => setMobileView(view)} style={{
              flex: 1,
              height: "100%",
              border: "none",
              borderBottom: mobileView === view ? "2px solid #a78bfa" : "2px solid transparent",
              background: mobileView === view ? "rgba(139,92,246,0.15)" : "transparent",
              color: mobileView === view ? "#c4b5fd" : "rgba(196,181,253,0.45)",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
              transition: "background 0.15s, color 0.15s",
            }}>
              {view === "chat" ? "💬 שיחה" : "📋 הצעה"}
            </button>
          ))}
        </div>
      )}

      {/* ── Panels row ────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "row", minHeight: 0, direction: "ltr" }}>

      {/* ── LEFT: Quote panel (white document) ──────────────────────────── */}
      <div style={{
        width: hasQuote ? (isMobile ? (mobileView === "preview" ? "100%" : "0") : "44%") : "0",
        minWidth: hasQuote && !isMobile ? "300px" : "0",
        transition: "width 0.4s ease, min-width 0.4s ease",
        overflow: "hidden",
        background: "#ffffff",
        borderRight: hasQuote && !isMobile ? "1px solid #e5e7eb" : "none",
        display: "flex",
        flexDirection: "column",
      }}>
        {hasQuote && (
          <QuotePanel
            quote={quote}
            companyName={effectiveContext?.company_name ?? ""}
            companyLogo={effectiveContext?.company_logo}
            onApprove={handleApprove}
            approveState={approveState}
            approveLabel="יצירת הצעה"
            onTitleChange={handleTitleChange}
            onDeleteItem={handleDeleteItem}
            onUpdateItem={handleUpdateItem}
            onUpdateTerms={handleUpdateTerms}
            onUpdateComments={handleUpdateComments}
          />
        )}
      </div>

      {/* ── RIGHT: Chat panel (dark) ─────────────────────────────────────── */}
      <div dir="rtl" style={{
        flex: 1,
        display: isMobile && hasQuote && mobileView === "preview" ? "none" : "flex",
        flexDirection: "column",
        minWidth: 0,
        color: "#e2e8f0",
      }}>

        {/* Header */}
        <div style={{
          padding: "14px 20px",
          borderBottom: "1px solid rgba(139,92,246,0.2)",
          background: "rgba(0,0,0,0.3)",
          backdropFilter: "blur(8px)",
          textAlign: "right",
        }}>
          <div style={{ fontSize: "15px", fontWeight: 600, color: "#c4b5fd" }}>{effectiveContext?.company_name}</div>
          <div style={{ fontSize: "12px", color: "rgba(196,181,253,0.6)", marginTop: 2 }}>{effectiveContext?.industry}</div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{
              display: "flex",
              // RTL: flex-start = right side, flex-end = left side
              justifyContent: msg.role === "user" ? "flex-start" : "flex-end",
            }}>
              <div style={{
                maxWidth: "80%",
                padding: "10px 14px",
                borderRadius: msg.role === "user" ? "18px 4px 18px 18px" : "4px 18px 18px 18px",
                background: msg.role === "user"
                  ? "rgba(139,92,246,0.2)"
                  : "rgba(255,255,255,0.08)",
                border: msg.role === "user"
                  ? "1px solid rgba(139,92,246,0.35)"
                  : "1px solid rgba(255,255,255,0.1)",
                fontSize: "14px",
                lineHeight: 1.65,
                color: "#e2e8f0",
                wordBreak: "break-word",
                textAlign: "right",
              }}>
                {msg.loading ? <QuoteLoader /> : msg.content}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Landing chips — only before first quote */}
        {!hasQuote && (
          <div style={{ padding: "0 16px 10px", display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-start" }}>
            <button
              onClick={() => sendMessage("צור לי הצעת מחיר חדשה", quote)}
              style={chipStyle}
            >
              הצעה חדשה
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={chipStyle}
            >
              שפר הצעה קיימת
            </button>
          </div>
        )}

        {/* Input bar */}
        <div style={{
          padding: "10px 14px",
          borderTop: "1px solid rgba(139,92,246,0.2)",
          background: "rgba(0,0,0,0.3)",
          backdropFilter: "blur(8px)",
        }}>
          <div style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 8,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(139,92,246,0.25)",
            borderRadius: 16,
            padding: "8px 10px",
          }}>
            {/* Mic — LEFT in JSX = RIGHT in RTL */}
            <button
              onClick={handleVoice}
              disabled={isLoading}
              title={isListening ? "עצור הקלטה" : "הקלד בקול"}
              style={{
                flexShrink: 0,
                width: 34,
                height: 34,
                borderRadius: "50%",
                border: isListening ? "1px solid rgba(239,68,68,0.6)" : "1px solid rgba(139,92,246,0.3)",
                background: isListening ? "rgba(239,68,68,0.15)" : "rgba(139,92,246,0.1)",
                color: isListening ? "#f87171" : "#a78bfa",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "16px",
              }}
            >
              🎙
            </button>

            {/* Textarea */}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="תאר את העבודה..."
              disabled={isLoading}
              rows={1}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#e2e8f0",
                fontSize: "14px",
                lineHeight: 1.5,
                resize: "none",
                maxHeight: 120,
                overflowY: "auto",
                direction: "rtl",
                textAlign: "right",
                fontFamily: "inherit",
              }}
              onInput={(e) => {
                const t = e.target as HTMLTextAreaElement;
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 120) + "px";
              }}
            />

            {/* Send — RIGHT in JSX = LEFT in RTL */}
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              style={{
                flexShrink: 0,
                width: 34,
                height: 34,
                borderRadius: "50%",
                border: "none",
                background: input.trim() && !isLoading
                  ? "linear-gradient(135deg, #7c3aed, #6d28d9)"
                  : "rgba(139,92,246,0.2)",
                color: "#fff",
                cursor: input.trim() && !isLoading ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "18px",
                transition: "background 0.2s",
              }}
            >
              ←
            </button>
          </div>
        </div>
      </div>
      </div>{/* end panels row */}

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={handleFileUpload} />

      {/* ── Post-approve overlay ── */}
      {(approveState === "success" || approveState === "reviewing" || approveState === "submitted") && (
        <div dir="rtl" style={{
          position: "fixed", inset: 0, zIndex: 50,
          background: "rgba(7,7,26,0.88)",
          backdropFilter: "blur(10px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(139,92,246,0.35)",
            borderRadius: 20, padding: "44px 36px",
            maxWidth: 380, width: "90%", textAlign: "center",
          }}>

            {/* Phase 1: success spinner */}
            {approveState === "success" && (
              <>
                <div style={{ fontSize: 40, marginBottom: 14 }}>✨</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#c4b5fd", marginBottom: 20 }}>מיד תעבור להצעה</div>
                <div className="qp-spinner" />
              </>
            )}

            {/* Phase 2: review form */}
            {approveState === "reviewing" && (
              <>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🌟</div>
                <div style={{ fontSize: 19, fontWeight: 700, color: "#c4b5fd", marginBottom: 4 }}>איך הייתה החוויה?</div>
                <div style={{ fontSize: 13, color: "rgba(196,181,253,0.55)", marginBottom: 22 }}>שניה מזמנך תעזור לנו להשתפר</div>

                {/* Stars */}
                <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 20 }}>
                  {[1,2,3,4,5].map((s) => (
                    <button key={s} onClick={() => setReviewStars(s)} style={{
                      fontSize: 34, background: "none", border: "none", cursor: "pointer",
                      opacity: s <= reviewStars ? 1 : 0.25, transition: "opacity 0.15s, transform 0.1s",
                      transform: s <= reviewStars ? "scale(1.1)" : "scale(1)",
                      lineHeight: 1, padding: 2,
                    }}>★</button>
                  ))}
                </div>

                {/* Comment */}
                <textarea
                  value={reviewComment}
                  onChange={(e) => setReviewComment(e.target.value)}
                  placeholder="תגובה קצרה (אופציונלי)..."
                  rows={3}
                  style={{
                    width: "100%", boxSizing: "border-box", marginBottom: 16,
                    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(139,92,246,0.3)",
                    borderRadius: 10, padding: "10px 12px", color: "#e2e8f0",
                    fontSize: "13px", resize: "none", outline: "none", direction: "rtl",
                    fontFamily: "inherit",
                  }}
                />

                <button
                  onClick={handleReviewSubmit}
                  disabled={reviewStars === 0}
                  style={{
                    width: "100%", padding: "13px 0", borderRadius: 50, border: "none",
                    background: reviewStars > 0
                      ? "linear-gradient(135deg, #7c3aed 0%, #a855f7 60%, #ec4899 100%)"
                      : "rgba(139,92,246,0.2)",
                    color: "#fff", fontSize: "15px", fontWeight: 700,
                    cursor: reviewStars > 0 ? "pointer" : "default",
                    boxShadow: reviewStars > 0 ? "0 4px 20px rgba(139,92,246,0.4)" : "none",
                    marginBottom: 10, transition: "background 0.2s",
                  }}
                >שלח ביקורת</button>

                <button onClick={handleSkipReview} style={{
                  background: "none", border: "none", color: "rgba(196,181,253,0.4)",
                  fontSize: "12px", cursor: "pointer", padding: "4px 8px",
                }}>דלג</button>
              </>
            )}

            {/* Phase 3: submitted */}
            {approveState === "submitted" && (
              <>
                <div style={{ fontSize: 44, marginBottom: 14 }}>🎉</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#c4b5fd", marginBottom: 6 }}>תודה על הביקורת!</div>
                <div style={{ fontSize: 13, color: "rgba(196,181,253,0.55)" }}>מעביר אותך להצעה...</div>
                <div className="qp-spinner" style={{ marginTop: 20 }} />
              </>
            )}

          </div>
        </div>
      )}
    </div>
  );
}

// ── Sparkle SVG icon ──────────────────────────────────────────────────────────
function SparkleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="white" opacity="0.95"/>
      <path d="M19 2L19.8 5.2L23 6L19.8 6.8L19 10L18.2 6.8L15 6L18.2 5.2L19 2Z" fill="white" opacity="0.7"/>
      <path d="M5 16L5.6 18.4L8 19L5.6 19.6L5 22L4.4 19.6L2 19L4.4 18.4L5 16Z" fill="white" opacity="0.7"/>
    </svg>
  );
}

// ── Quote Panel — white document design ───────────────────────────────────────
function QuotePanel({
  quote,
  companyName,
  companyLogo,
  onApprove,
  approveState,
  approveLabel,
  onTitleChange,
  onDeleteItem,
  onUpdateItem,
  onUpdateTerms,
  onUpdateComments,
}: {
  quote: Partial<Quote>;
  companyName: string;
  companyLogo?: string;
  onApprove: () => void;
  approveState: "idle" | "loading" | "success" | "reviewing" | "submitted" | "error";
  onTitleChange: (title: string) => void;
  onDeleteItem: (index: number) => void;
  onUpdateItem: (index: number, name: string, description: string) => void;
  onUpdateTerms: (terms: string) => void;
  onUpdateComments: (comments: string) => void;
  approveLabel?: string;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const [editingItemIdx, setEditingItemIdx] = useState<number | null>(null);
  const [itemNameDraft, setItemNameDraft] = useState("");
  const [itemDescDraft, setItemDescDraft] = useState("");

  const [editingTerms, setEditingTerms] = useState(false);
  const [termsDraft, setTermsDraft] = useState("");

  const [editingComments, setEditingComments] = useState(false);
  const [commentsDraft, setCommentsDraft] = useState("");

  const startEditTitle = () => { setTitleDraft(quote.title ?? ""); setEditingTitle(true); };
  const commitTitle = () => { setEditingTitle(false); if (titleDraft.trim()) onTitleChange(titleDraft.trim()); };

  const startEditItem = (i: number) => {
    setEditingItemIdx(i);
    setItemNameDraft(quote.items?.[i]?.name ?? "");
    setItemDescDraft(quote.items?.[i]?.description ?? "");
  };
  const commitItem = () => {
    if (editingItemIdx === null) return;
    const idx = editingItemIdx;
    setEditingItemIdx(null);
    if (itemNameDraft.trim()) onUpdateItem(idx, itemNameDraft.trim(), itemDescDraft);
  };

  const combinedTerms = [quote.warranty, quote.terms].filter(Boolean).join("\n\n");
  const startEditTerms = () => { setTermsDraft(combinedTerms); setEditingTerms(true); };
  const commitTerms = () => { setEditingTerms(false); onUpdateTerms(termsDraft); };

  const combinedNotes = quote.comments ?? "";
  const startEditComments = () => { setCommentsDraft(combinedNotes); setEditingComments(true); };
  const commitComments = () => { setEditingComments(false); onUpdateComments(commentsDraft); };

  const editInputStyle: React.CSSProperties = {
    width: "100%", fontSize: "13px", color: "#374151",
    border: "1px solid #a78bfa", borderRadius: 6, padding: "4px 8px",
    outline: "none", fontFamily: "inherit", direction: "rtl",
    background: "#faf5ff", boxSizing: "border-box",
  };
  const editTextareaStyle: React.CSSProperties = {
    ...editInputStyle, resize: "vertical" as const, lineHeight: 1.6, minHeight: 60,
  };

  return (
    <>
    <style>{`
      @media (hover: hover) {
        .qp-item-action { opacity: 0; transition: opacity 0.15s; }
        .qp-item:hover .qp-item-action { opacity: 1; }
        .qp-edit-icon { opacity: 0; transition: opacity 0.15s; }
        .qp-section:hover .qp-edit-icon { opacity: 1; }
      }
      @keyframes qp-spin { to { transform: rotate(360deg); } }
      .qp-spinner { width: 36px; height: 36px; border: 3px solid rgba(196,181,253,0.2); border-top-color: #a78bfa; border-radius: 50%; animation: qp-spin 0.8s linear infinite; margin: 0 auto; }
    `}</style>
    <div dir="rtl" style={{ flex: 1, overflowY: "auto", background: "#ffffff", color: "#1a1a2e", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "24px 20px", maxWidth: "100%" }}>

        {/* Company box */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 18,
          padding: "12px 14px",
          background: "#f9fafb",
          borderRadius: 10,
          border: "1px solid #e5e7eb",
        }}>
          {companyLogo ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={companyLogo}
              alt={companyName}
              style={{ width: 48, height: 48, borderRadius: 8, objectFit: "contain", flexShrink: 0, background: "#fff", border: "1px solid #e5e7eb" }}
            />
          ) : (
            <div style={{
              width: 48, height: 48, borderRadius: 8, background: "#ede9fe",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "20px", fontWeight: 800, color: "#7c3aed", flexShrink: 0,
            }}>
              {companyName.charAt(0)}
            </div>
          )}
          <div>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#111827" }}>{companyName}</div>
            {quote.date && (
              <div style={{ fontSize: "11px", color: "#9ca3af", marginTop: 2 }}>
                {new Date(quote.date).toLocaleDateString("he-IL")}
              </div>
            )}
          </div>
        </div>

        {/* Document header */}
        <div style={{ textAlign: "center", marginBottom: 20, paddingBottom: 16, borderBottom: "2px solid #7c3aed" }}>
          <div style={{ fontSize: "20px", fontWeight: 800, color: "#1e1b4b", letterSpacing: -0.5 }}>
            הצעת מחיר
          </div>
        </div>

        {/* Title — inline editable */}
        {quote.title && (
          <div style={{ marginBottom: 16 }}>
            {editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => { if (e.key === "Enter") commitTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                style={{ ...editInputStyle, fontWeight: 600 }}
              />
            ) : (
              <div
                onClick={startEditTitle}
                title="לחץ לעריכה"
                className="qp-section"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 6,
                  cursor: "text",
                } as React.CSSProperties}
              >
                <span style={{ fontSize: "13px", fontWeight: 600, color: "#374151", lineHeight: 1.5, flex: 1 }}>
                  {quote.title}
                </span>
                <span className="qp-edit-icon" style={{ fontSize: "13px", color: "#a78bfa", flexShrink: 0, marginTop: 2 }} title="ערוך כותרת">✏️</span>
              </div>
            )}
          </div>
        )}

        {/* Client */}
        {(quote.client?.name || quote.client?.address || quote.client?.phone || quote.client?.email) && (
          <div style={{ marginBottom: 18, padding: "12px 14px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
              פרטי לקוח
            </div>
            {quote.client.name    && <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827" }}>{quote.client.name}</div>}
            {quote.client.address && <div style={{ fontSize: "12px", color: "#6b7280", marginTop: 3 }}>{quote.client.address}</div>}
            {quote.client.phone   && <div style={{ fontSize: "12px", color: "#6b7280", marginTop: 2 }}>{quote.client.phone}</div>}
            {quote.client.email   && <div style={{ fontSize: "12px", color: "#6b7280", marginTop: 2 }}>{quote.client.email}</div>}
          </div>
        )}

        {/* Items */}
        {quote.items && quote.items.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
              פריטי עבודה
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {quote.items.map((item, i) => (
                <div key={i} className="qp-item" style={{
                  display: "flex",
                  gap: 8,
                  padding: "10px 0",
                  borderBottom: "1px solid #f3f4f6",
                  alignItems: "flex-start",
                }}>
                  {/* Number badge */}
                  <span style={{
                    flexShrink: 0,
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: "#ede9fe",
                    color: "#7c3aed",
                    fontSize: "11px",
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginTop: 1,
                  }}>
                    {i + 1}
                  </span>
                  {/* Content — editable */}
                  {editingItemIdx === i ? (
                    <div
                      style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}
                      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) commitItem(); }}
                    >
                      <input
                        autoFocus
                        value={itemNameDraft}
                        onChange={(e) => setItemNameDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitItem(); } if (e.key === "Escape") setEditingItemIdx(null); }}
                        placeholder="שם פריט"
                        style={{ ...editInputStyle, fontWeight: 600 }}
                      />
                      <textarea
                        value={itemDescDraft}
                        onChange={(e) => setItemDescDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Escape") setEditingItemIdx(null); }}
                        placeholder="תיאור"
                        rows={2}
                        style={{ ...editInputStyle, resize: "vertical", lineHeight: 1.5 }}
                      />
                    </div>
                  ) : (
                    <div
                      style={{ flex: 1, minWidth: 0, cursor: "text" }}
                      onClick={() => startEditItem(i)}
                      title="לחץ לעריכה"
                    >
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
                        <span style={{ fontSize: "13px", fontWeight: 600, color: "#111827", flex: 1 }}>{item.name}</span>
                        <span className="qp-item-action" style={{ fontSize: "12px", color: "#a78bfa", flexShrink: 0 }}>✏️</span>
                      </div>
                      {item.description && (
                        <div style={{ fontSize: "11px", color: "#6b7280", marginTop: 3, lineHeight: 1.5 }}>{item.description}</div>
                      )}
                    </div>
                  )}
                  {/* Delete button */}
                  <button
                    className="qp-item-action"
                    onClick={() => onDeleteItem(i)}
                    title="הסר פריט"
                    style={{
                      flexShrink: 0,
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      border: "1px solid #fca5a5",
                      background: "transparent",
                      color: "#f87171",
                      fontSize: "13px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      lineHeight: 1,
                      padding: 0,
                      marginTop: 1,
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#fee2e2")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Total */}
        {quote.total !== undefined && (
          <div style={{ marginBottom: 18, padding: "14px 16px", background: "#f5f3ff", borderRadius: 8, border: "1px solid #ddd6fe" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "20px", fontWeight: 800, color: "#5b21b6" }}>{formatILS(quote.total)}</span>
              <span style={{ fontSize: "13px", color: "#7c3aed", fontWeight: 600 }}>סה&quot;כ לתשלום</span>
            </div>
            {quote.has_tax && quote.tax_amount !== undefined && (
              <div style={{ fontSize: "11px", color: "#8b5cf6", marginTop: 6, textAlign: "left" }}>
                כולל מע&quot;מ 18% — {formatILS(quote.tax_amount)}
              </div>
            )}
          </div>
        )}

        {/* Terms — editable */}
        {combinedTerms && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>תנאים ותקנון</div>
            {editingTerms ? (
              <textarea
                autoFocus
                value={termsDraft}
                onChange={(e) => setTermsDraft(e.target.value)}
                onBlur={commitTerms}
                onKeyDown={(e) => { if (e.key === "Escape") setEditingTerms(false); }}
                rows={3}
                style={editTextareaStyle}
              />
            ) : (
              <div onClick={startEditTerms} title="לחץ לעריכה" className="qp-section" style={{ cursor: "text", display: "flex", alignItems: "flex-start", gap: 4 }}>
                <span style={{ fontSize: "12px", color: "#4b5563", lineHeight: 1.6, flex: 1, whiteSpace: "pre-wrap" }}>{combinedTerms}</span>
                <span className="qp-edit-icon" style={{ fontSize: "12px", color: "#a78bfa", flexShrink: 0 }}>✏️</span>
              </div>
            )}
          </div>
        )}

        {/* Comments + warranty — editable */}
        {combinedNotes && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>הערות</div>
            {editingComments ? (
              <textarea
                autoFocus
                value={commentsDraft}
                onChange={(e) => setCommentsDraft(e.target.value)}
                onBlur={commitComments}
                onKeyDown={(e) => { if (e.key === "Escape") setEditingComments(false); }}
                rows={4}
                style={editTextareaStyle}
              />
            ) : (
              <div onClick={startEditComments} title="לחץ לעריכה" className="qp-section" style={{ cursor: "text", display: "flex", alignItems: "flex-start", gap: 4 }}>
                <span style={{ fontSize: "12px", color: "#4b5563", lineHeight: 1.6, flex: 1, whiteSpace: "pre-wrap" }}>{combinedNotes}</span>
                <span className="qp-edit-icon" style={{ fontSize: "12px", color: "#a78bfa", flexShrink: 0 }}>✏️</span>
              </div>
            )}
          </div>
        )}

        {/* Spacer so content doesn't hide behind sticky button */}
        <div style={{ height: 80 }} />

      </div>

      {/* ── Floating approve button ── */}
      {(() => {
        const canApprove = (quote.items?.length ?? 0) > 0 && (quote.total ?? 0) > 0;
        const isDisabled = (approveState !== "idle" && approveState !== "error") || !canApprove;
        const helperText = !canApprove
          ? ((quote.items?.length ?? 0) === 0 ? "ממתין לפריטי עבודה..." : "עדכן מחיר כדי להמשיך")
          : "נעביר אותך לעמוד תצוגה ושיתוף ההצעה";
        return (
          <div style={{
            position: "sticky",
            bottom: 0,
            background: "linear-gradient(to top, #ffffff 70%, transparent)",
            padding: "16px 20px 20px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
          }}>
            <button
              onClick={canApprove ? onApprove : undefined}
              disabled={isDisabled}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "15px 36px",
                borderRadius: 50,
                border: "none",
                background: approveState === "error"
                  ? "linear-gradient(135deg, #ef4444, #dc2626)"
                  : "linear-gradient(135deg, #7c3aed 0%, #a855f7 60%, #ec4899 100%)",
                color: "#fff",
                fontSize: "17px",
                fontWeight: 700,
                cursor: !isDisabled ? "pointer" : "default",
                boxShadow: canApprove ? "0 4px 24px rgba(139,92,246,0.45)" : "none",
                opacity: !canApprove && approveState === "idle" ? 0.4 : 1,
                transition: "transform 0.15s, box-shadow 0.15s, background 0.3s, opacity 0.2s",
                transform: approveState === "loading" ? "scale(0.97)" : "scale(1)",
                letterSpacing: 0.3,
              }}
            >
              {approveState === "loading" ? (
                <span style={{ opacity: 0.85 }}>שולח...</span>
              ) : approveState === "error" ? (
                <>✕ שגיאה, נסה שוב</>
              ) : (
                <><SparkleIcon /> {approveLabel ?? "יצירת הצעה"}</>
              )}
            </button>
            {approveState === "idle" && (
              <div style={{ fontSize: "11px", color: "rgba(0,0,0,0.4)", textAlign: "center" }}>
                {helperText}
              </div>
            )}
          </div>
        );
      })()}
    </div>
    </>
  );
}

// ── Deep merge ─────────────────────────────────────────────────────────────────
function mergeQuote(current: Partial<Quote>, update: PartialQuote): Partial<Quote> {
  const merged: Partial<Quote> = { ...current };
  if (update.title      !== undefined) merged.title      = update.title;
  if (update.date       !== undefined) merged.date       = update.date;
  if (update.scope      !== undefined) merged.scope      = update.scope;
  if (update.industry   !== undefined) merged.industry   = update.industry;
  if (update.warranty   !== undefined) merged.warranty   = update.warranty;
  if (update.terms      !== undefined) merged.terms      = update.terms;
  if (update.comments   !== undefined) merged.comments   = update.comments;
  if (update.status     !== undefined) merged.status     = update.status;
  if (update.total      !== undefined) merged.total      = update.total;
  if (update.has_tax    !== undefined) merged.has_tax    = update.has_tax;
  if (update.tax_amount !== undefined) merged.tax_amount = update.tax_amount;
  if (update.items      !== undefined) merged.items      = update.items as Quote["items"];
  if (update.client) {
    merged.client = { ...(current.client ?? {}), ...update.client };
  }
  return merged;
}

// ── Chip style ─────────────────────────────────────────────────────────────────
const chipStyle: React.CSSProperties = {
  padding: "8px 18px",
  borderRadius: 20,
  border: "1px solid rgba(139,92,246,0.35)",
  background: "rgba(139,92,246,0.12)",
  color: "#c4b5fd",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 0.2s",
};
