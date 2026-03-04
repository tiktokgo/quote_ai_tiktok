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
  aiContext: AIContext & { quote_id?: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatILS(n: number): string {
  return new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ChatPage({ aiContext }: ChatPageProps) {
  const [messages, setMessages]     = useState<ChatMessage[]>([]);
  const [input, setInput]           = useState("");
  const [isLoading, setIsLoading]   = useState(false);
  const [quote, setQuote]           = useState<Partial<Quote>>({});

  const bottomRef      = useRef<HTMLDivElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);   // Improve quote (AI-enhanced)
  const extractFileRef = useRef<HTMLInputElement>(null);   // Upload quote (extract-only)
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [isListening, setIsListening] = useState(false);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Opening greeting
  useEffect(() => {
    const greeting = aiContext.user_name
      ? `שלום ${aiContext.user_name}! אני עוזר הצעות המחיר שלך עבור ${aiContext.company_name}. ספר לי על העבודה ואני אבנה הצעת מחיר מיד.`
      : `אני עוזר הצעות המחיר שלך עבור ${aiContext.company_name}. ספר לי על העבודה ואני אבנה הצעת מחיר מיד.`;
    setMessages([{ role: "assistant", content: greeting }]);
  }, [aiContext]);

  // ── Send message ─────────────────────────────────────────────────────────────
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
        body: JSON.stringify({
          messages: historyForApi,
          aiContext,
          currentQuote,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              content?: string;
              quote?: PartialQuote;
              ok?: boolean;
              message?: string;
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
          } catch {
            // ignore parse errors
          }
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

  // ── PDF: Improve quote (AI-enhanced) ────────────────────────────────────────
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
      if (!parseRes.ok) throw new Error(`PDF parse failed: HTTP ${parseRes.status}`);
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

  // ── PDF: Extract-only ────────────────────────────────────────────────────────
  const handleExtractUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
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
      if (!parseRes.ok) throw new Error(`PDF parse failed: HTTP ${parseRes.status}`);
      const { text } = await parseRes.json() as { text: string };

      setIsLoading(false);
      setMessages((prev) => prev.filter((m) => !m.loading));

      const prompt = `חלץ בלבד — מפה את השדות מה-PDF בדיוק כפי שכתוב. אל תוסיף פריטים. אל תשנה תיאורים. אל תשדרג אחריות או תנאים. חלץ רק את מה שנמצא במסמך:\n\n${text}`;
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

  // ── Voice input ──────────────────────────────────────────────────────────────
  const handleVoice = useCallback(() => {
    if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
      alert("הדפדפן שלך אינו תומך בזיהוי קול");
      return;
    }
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }
    const SR = (window as unknown as { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "he-IL";
    rec.interimResults = false;
    rec.onstart = () => setIsListening(true);
    rec.onend   = () => setIsListening(false);
    rec.onerror = () => setIsListening(false);
    rec.onresult = (e: SpeechRecognitionEvent) => {
      const transcript = e.results[0]?.[0]?.transcript ?? "";
      if (transcript) setInput((prev) => (prev ? prev + " " + transcript : transcript));
    };
    recognitionRef.current = rec;
    rec.start();
  }, [isListening]);

  // ── Keyboard ──────────────────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // ── Quote panel helpers ───────────────────────────────────────────────────────
  const hasQuote = (quote.items?.length ?? 0) > 0 || quote.title;

  return (
    <div dir="rtl" style={{
      display: "flex",
      height: "100dvh",
      fontFamily: "'Segoe UI', Arial, sans-serif",
      background: "linear-gradient(180deg, #07071a 0%, #0b0920 50%, #0f0c28 100%)",
      color: "#e2e8f0",
      overflow: "hidden",
    }}>
      {/* ── Left panel: Quote ─────────────────────────────────────────────── */}
      <div style={{
        width: hasQuote ? "42%" : "0",
        minWidth: hasQuote ? "320px" : "0",
        transition: "width 0.4s ease, min-width 0.4s ease",
        overflow: "hidden",
        borderLeft: hasQuote ? "1px solid rgba(139,92,246,0.2)" : "none",
        display: "flex",
        flexDirection: "column",
      }}>
        {hasQuote && <QuotePanel quote={quote} />}
      </div>

      {/* ── Right panel: Chat ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Header */}
        <div style={{
          padding: "14px 20px",
          borderBottom: "1px solid rgba(139,92,246,0.2)",
          background: "rgba(0,0,0,0.3)",
          backdropFilter: "blur(8px)",
        }}>
          <div style={{ fontSize: "15px", fontWeight: 600, color: "#c4b5fd" }}>
            {aiContext.company_name}
          </div>
          <div style={{ fontSize: "12px", color: "rgba(196,181,253,0.6)", marginTop: 2 }}>
            {aiContext.industry}
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-start" : "flex-end" }}>
              <div style={{
                maxWidth: "78%",
                padding: "10px 14px",
                borderRadius: msg.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                background: msg.role === "user"
                  ? "rgba(139,92,246,0.18)"
                  : "rgba(255,255,255,0.07)",
                border: msg.role === "user"
                  ? "1px solid rgba(139,92,246,0.3)"
                  : "1px solid rgba(255,255,255,0.1)",
                fontSize: "14px",
                lineHeight: 1.6,
                color: "#e2e8f0",
                wordBreak: "break-word",
              }}>
                {msg.loading ? <QuoteLoader /> : msg.content}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Landing chips — shown only when no quote yet */}
        {!hasQuote && (
          <div style={{ padding: "0 20px 12px", display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {[
              { label: "הצעת מחיר חדשה", prompt: "צור לי הצעת מחיר חדשה" },
              { label: "תיקון / תחזוקה",  prompt: "עבודת תיקון ותחזוקה" },
            ].map((chip) => (
              <button key={chip.label} onClick={() => { setInput(chip.prompt); }} style={chipStyle}>
                {chip.label}
              </button>
            ))}
            <button onClick={() => fileInputRef.current?.click()} style={chipStyle}>
              שפר הצעה
            </button>
            <button onClick={() => extractFileRef.current?.click()} style={chipStyle}>
              העלה הצעה
            </button>
          </div>
        )}

        {/* Input bar */}
        <div style={{
          padding: "12px 16px",
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
            padding: "8px 12px",
          }}>
            {/* Upload Quote button */}
            <button
              onClick={() => extractFileRef.current?.click()}
              disabled={isLoading}
              title="העלה הצעה קיימת"
              style={{
                flexShrink: 0,
                padding: "5px 12px",
                borderRadius: 20,
                border: "1px solid rgba(139,92,246,0.4)",
                background: "rgba(139,92,246,0.15)",
                color: "#c4b5fd",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              העלה הצעה
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
                fontFamily: "inherit",
              }}
              onInput={(e) => {
                const t = e.target as HTMLTextAreaElement;
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 120) + "px";
              }}
            />

            {/* Mic */}
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

            {/* Send */}
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
                fontSize: "16px",
                transition: "background 0.2s",
              }}
            >
              ➤
            </button>
          </div>
        </div>
      </div>

      {/* Hidden file inputs */}
      <input ref={fileInputRef}   type="file" accept=".pdf" className="hidden" onChange={handleFileUpload}   />
      <input ref={extractFileRef} type="file" accept=".pdf" className="hidden" onChange={handleExtractUpload} />
    </div>
  );
}

// ── Quote Panel ────────────────────────────────────────────────────────────────
function QuotePanel({ quote }: { quote: Partial<Quote> }) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px", direction: "rtl" }}>
      <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: 1, color: "rgba(196,181,253,0.5)", marginBottom: 12 }}>
        הצעת מחיר
      </div>

      {quote.title && (
        <h2 style={{ fontSize: "15px", fontWeight: 700, color: "#e9d5ff", marginBottom: 4, lineHeight: 1.4 }}>
          {quote.title}
        </h2>
      )}

      {quote.date && (
        <div style={{ fontSize: "12px", color: "rgba(196,181,253,0.5)", marginBottom: 12 }}>
          {new Date(quote.date).toLocaleDateString("he-IL")}
        </div>
      )}

      {/* Client info */}
      {(quote.client?.name || quote.client?.address || quote.client?.phone || quote.client?.email) && (
        <div style={{ marginBottom: 16, padding: "10px 12px", background: "rgba(255,255,255,0.04)", borderRadius: 8, border: "1px solid rgba(139,92,246,0.15)" }}>
          <div style={{ fontSize: "11px", color: "rgba(196,181,253,0.5)", marginBottom: 6 }}>לקוח</div>
          {quote.client.name    && <div style={{ fontSize: "13px", color: "#e2e8f0", fontWeight: 600 }}>{quote.client.name}</div>}
          {quote.client.address && <div style={{ fontSize: "12px", color: "rgba(226,232,240,0.7)", marginTop: 2 }}>{quote.client.address}</div>}
          {quote.client.phone   && <div style={{ fontSize: "12px", color: "rgba(226,232,240,0.7)", marginTop: 2 }}>{quote.client.phone}</div>}
          {quote.client.email   && <div style={{ fontSize: "12px", color: "rgba(226,232,240,0.7)", marginTop: 2 }}>{quote.client.email}</div>}
        </div>
      )}

      {/* Items */}
      {quote.items && quote.items.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: "11px", color: "rgba(196,181,253,0.5)", marginBottom: 8 }}>פריטים</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {quote.items.map((item, i) => (
              <div key={i} style={{ padding: "8px 10px", background: "rgba(255,255,255,0.04)", borderRadius: 6, border: "1px solid rgba(139,92,246,0.1)" }}>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#ddd6fe" }}>{item.name}</div>
                {item.description && (
                  <div style={{ fontSize: "11px", color: "rgba(226,232,240,0.6)", marginTop: 3, lineHeight: 1.4 }}>{item.description}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Total */}
      {(quote.total !== undefined) && (
        <div style={{ marginBottom: 12, padding: "10px 12px", background: "rgba(139,92,246,0.12)", borderRadius: 8, border: "1px solid rgba(139,92,246,0.3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "13px", color: "rgba(196,181,253,0.8)" }}>סה"כ לתשלום</span>
            <span style={{ fontSize: "18px", fontWeight: 700, color: "#e9d5ff" }}>{formatILS(quote.total)}</span>
          </div>
          {quote.has_tax && quote.tax_amount !== undefined && (
            <div style={{ fontSize: "11px", color: "rgba(196,181,253,0.6)", marginTop: 4 }}>
              כולל מע"מ 18% ({formatILS(quote.tax_amount)})
            </div>
          )}
        </div>
      )}

      {/* Warranty */}
      {quote.warranty && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: "11px", color: "rgba(196,181,253,0.5)", marginBottom: 4 }}>אחריות</div>
          <div style={{ fontSize: "12px", color: "rgba(226,232,240,0.7)", lineHeight: 1.5 }}>{quote.warranty}</div>
        </div>
      )}

      {/* Terms */}
      {quote.terms && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: "11px", color: "rgba(196,181,253,0.5)", marginBottom: 4 }}>תנאי תשלום</div>
          <div style={{ fontSize: "12px", color: "rgba(226,232,240,0.7)", lineHeight: 1.5 }}>{quote.terms}</div>
        </div>
      )}

      {/* Comments */}
      {quote.comments && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: "11px", color: "rgba(196,181,253,0.5)", marginBottom: 4 }}>הערות</div>
          <div style={{ fontSize: "12px", color: "rgba(226,232,240,0.7)", lineHeight: 1.5 }}>{quote.comments}</div>
        </div>
      )}
    </div>
  );
}

// ── Deep merge quote ──────────────────────────────────────────────────────────
function mergeQuote(current: Partial<Quote>, update: PartialQuote): Partial<Quote> {
  const merged: Partial<Quote> = { ...current };
  if (update.title    !== undefined) merged.title    = update.title;
  if (update.date     !== undefined) merged.date     = update.date;
  if (update.scope    !== undefined) merged.scope    = update.scope;
  if (update.industry !== undefined) merged.industry = update.industry;
  if (update.warranty !== undefined) merged.warranty = update.warranty;
  if (update.terms    !== undefined) merged.terms    = update.terms;
  if (update.comments !== undefined) merged.comments = update.comments;
  if (update.status   !== undefined) merged.status   = update.status;
  if (update.total    !== undefined) merged.total    = update.total;
  if (update.has_tax  !== undefined) merged.has_tax  = update.has_tax;
  if (update.tax_amount !== undefined) merged.tax_amount = update.tax_amount;
  if (update.items    !== undefined) merged.items    = update.items as Quote["items"];
  if (update.client) {
    merged.client = {
      ...(current.client ?? {}),
      ...update.client,
    };
  }
  return merged;
}

// ── Chip style ────────────────────────────────────────────────────────────────
const chipStyle: React.CSSProperties = {
  padding: "7px 14px",
  borderRadius: 20,
  border: "1px solid rgba(139,92,246,0.35)",
  background: "rgba(139,92,246,0.1)",
  color: "#c4b5fd",
  fontSize: "13px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 0.2s",
};
