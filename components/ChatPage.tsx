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
  token?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatILS(n: number): string {
  return new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ChatPage({ aiContext, isGuest, token }: ChatPageProps) {
  const [messages, setMessages]   = useState<ChatMessage[]>([]);
  const [input, setInput]         = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [quote, setQuote]         = useState<Partial<Quote>>({});

  // ── Guest state ───────────────────────────────────────────────────────────
  const [guestInfo, setGuestInfo] = useState<{ company_name: string; email: string; industry: string; address?: string; logo_url?: string } | null>(null);
  const [guestDraft, setGuestDraft] = useState({ company_name: "", email: "", industry: "", address: "", logo_url: "", website: "" });
  const [scanState, setScanState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [scanError, setScanError] = useState("");
  const [scanResult, setScanResult] = useState<{ logo_url?: string; company_name?: string; industry?: string; email?: string; address?: string } | null>(null);

  const effectiveContext: (AIContext & { user_id?: string }) | undefined =
    aiContext ?? (guestInfo ? {
      company_name: guestInfo.company_name,
      industry:     guestInfo.industry,
      company_logo: guestInfo.logo_url || undefined,
      company_info: [
        guestInfo.email   && `אימייל: ${guestInfo.email}`,
        guestInfo.address && `כתובת: ${guestInfo.address}`,
      ].filter(Boolean).join("\n"),
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
        body: JSON.stringify({ messages: historyForApi, aiContext: effectiveContext, currentQuote, token }),
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
              setMobileView("preview");
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
    setTimeout(() => textareaRef.current?.focus(), 0);
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
    setQuote((prev) => ({ ...prev, terms, warranty: "" })); // warranty merged into terms on manual edit
  }, []);

  const handleUpdateComments = useCallback((comments: string) => {
    setQuote((prev) => ({ ...prev, comments }));
  }, []);

  // ── Manual price + address edits (passed to QuotePanel) ──────────────────
  const handleUpdateTotal = useCallback((total: number) => {
    setQuote((prev) => ({ ...prev, total }));
  }, []);

  const handleUpdateAddress = useCallback((address: string) => {
    setQuote((prev) => ({ ...prev, client: { ...(prev.client ?? {}), address } }));
  }, []);

  // ── Approve quote → send full quote to Bubble ─────────────────────────────
  const [approveState, setApproveState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [quoteId, setQuoteId] = useState<string | undefined>();
  const [reviewStars, setReviewStars] = useState(0);
  const [reviewComment, setReviewComment] = useState("");
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  const handleReviewSubmit = useCallback(async () => {
    setReviewSubmitted(true);
    if (reviewStars === 0) return;
    await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote_id: quoteId, user_id: aiContext?.user_id, stars: reviewStars, comment: reviewComment }),
    }).catch(() => {});
  }, [reviewStars, reviewComment, quoteId, aiContext?.user_id]);

  useEffect(() => () => { if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current); }, []);

  const handleApprove = useCallback(async () => {
    setApproveState("loading");
    try {
      let res: Response;
      const quoteWithTax = { ...quote, has_tax: quote.has_tax ?? false };
      if (isGuest && guestInfo) {
        res = await fetch("/api/onboard-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            company_name: guestInfo.company_name,
            email:        guestInfo.email,
            industry:     guestInfo.industry,
            address:      guestInfo.address,
            logo_url:     guestInfo.logo_url,
            quote:        quoteWithTax,
          }),
        });
      } else {
        res = await fetch("/api/approve-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: aiContext?.user_id, quote: quoteWithTax }),
        });
      }
      const data = await res.json() as { ok: boolean; quote_id?: string; redirect_url?: string };
      console.log("[handleApprove] API response:", JSON.stringify(data));
      if (data.ok) {
        const id = data.quote_id;
        const guestRedirectUrl = data.redirect_url ?? (process.env.NEXT_PUBLIC_GUEST_REDIRECT_URL || undefined);
        console.log("[handleApprove] isGuest:", isGuest, "guestRedirectUrl:", guestRedirectUrl);
        setQuoteId(id);
        setReviewStars(0);
        setReviewComment("");
        setReviewSubmitted(false);
        setApproveState("success");
        if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = setTimeout(() => {
          redirectTimerRef.current = null;
          const inIframe = window.parent !== window;
          console.log("[redirect timer] fired — isGuest:", isGuest, "guestRedirectUrl:", guestRedirectUrl, "inIframe:", inIframe);
          if (isGuest) {
            // New user: redirect only to the URL returned by the onboarding API
            if (guestRedirectUrl) {
              if (inIframe) {
                window.parent.postMessage({ type: "quote_redirect", url: guestRedirectUrl }, "*");
              } else {
                window.location.href = guestRedirectUrl;
              }
            }
            // If no redirect_url returned, stay on page (do nothing)
          } else {
            // Existing user: redirect using NEXT_PUBLIC_REDIRECT_BASE + quote_id
            const base = process.env.NEXT_PUBLIC_REDIRECT_BASE ?? "";
            if (base && id) {
              const url = base + id;
              if (inIframe) {
                window.parent.postMessage({ type: "quote_redirect", url }, "*");
              } else {
                window.location.href = url;
              }
            } else {
              setApproveState("idle");
            }
          }
        }, 11000);
      } else {
        setApproveState("error");
        setTimeout(() => setApproveState("idle"), 3000);
      }
    } catch {
      setApproveState("error");
      setTimeout(() => setApproveState("idle"), 3000);
    }
  }, [aiContext, isGuest, guestInfo, quote]);

  // ── Website scanner ────────────────────────────────────────────────────────
  const handleScanWebsite = useCallback(async () => {
    const site = guestDraft.website.trim();
    if (!site) return;
    setScanState("loading");
    setScanError("");
    try {
      const res = await fetch("/api/scan-website", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: site }),
      });
      const data = await res.json() as { ok: boolean; message?: string; logo_url?: string; company_name?: string; industry?: string; email?: string; address?: string };
      if (!data.ok) {
        setScanState("error");
        setScanError(data.message ?? "לא הצלחנו לסרוק את האתר");
        return;
      }
      console.log("[scan-website] result:", JSON.stringify(data));
      const gotSomething = data.company_name || data.industry || data.email || data.logo_url;
      if (!gotSomething) {
        setScanState("error");
        setScanError("לא הצלחנו לחלץ פרטים — מלא ידנית");
        return;
      }
      setScanResult({ logo_url: data.logo_url, company_name: data.company_name, industry: data.industry, email: data.email, address: data.address });
      setGuestDraft((p) => ({
        ...p,
        company_name: data.company_name || p.company_name,
        industry:     data.industry     || p.industry,
        email:        data.email        || p.email,
        address:      data.address      || p.address,
        logo_url:     data.logo_url     || p.logo_url,
      }));
      setScanState("done");
    } catch {
      setScanState("error");
      setScanError("שגיאת רשת — נסה שוב");
    }
  }, [guestDraft.website]);


  // ── Guest form (no token) ──────────────────────────────────────────────────
  if (isGuest && !guestInfo) {
    const canSubmit = guestDraft.company_name.trim() && guestDraft.email.trim() && guestDraft.industry.trim();
    return (
      <div dir="rtl" style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "100dvh",
        overflow: "hidden",
        background: "linear-gradient(180deg, #07071a 0%, #0b0920 50%, #0f0c28 100%)",
      }}>
        {/* ── Blurred app preview background ── */}
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "row",
          filter: "blur(8px)",
          transform: "scale(1.06)",
          pointerEvents: "none",
          userSelect: "none",
          direction: "ltr",
        }}>
          {/* Left: Quote panel mock */}
          <div style={{ width: "44%", background: "#fff", display: "flex", flexDirection: "column", padding: "20px 16px", gap: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 10, padding: "10px 12px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb" }}>
              <div style={{ width: 40, height: 40, borderRadius: 6, background: "#ede9fe", flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ height: 11, width: "55%", background: "#d1d5db", borderRadius: 3, marginBottom: 6 }} />
                <div style={{ height: 8, width: "35%", background: "#e5e7eb", borderRadius: 3 }} />
              </div>
            </div>
            <div style={{ textAlign: "center", paddingBottom: 10, borderBottom: "2px solid #7c3aed" }}>
              <div style={{ height: 13, width: "40%", background: "#1e1b4b", borderRadius: 3, margin: "0 auto" }} />
            </div>
            <div style={{ height: 11, width: "75%", background: "#374151", borderRadius: 3 }} />
            <div style={{ padding: "9px 11px", background: "#f9fafb", borderRadius: 7, border: "1px solid #e5e7eb" }}>
              <div style={{ height: 7, width: "28%", background: "#9ca3af", borderRadius: 3, marginBottom: 7 }} />
              <div style={{ height: 11, width: "58%", background: "#374151", borderRadius: 3, marginBottom: 5 }} />
              <div style={{ height: 9, width: "42%", background: "#9ca3af", borderRadius: 3 }} />
            </div>
            <div style={{ height: 7, width: "22%", background: "#9ca3af", borderRadius: 3 }} />
            {[53, 68, 45, 72, 60].map((w, i) => (
              <div key={i} style={{ display: "flex", gap: 8, paddingBottom: 9, borderBottom: "1px solid #f3f4f6", alignItems: "flex-start" }}>
                <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#ede9fe", flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ height: 10, width: `${w}%`, background: "#374151", borderRadius: 3, marginBottom: 4 }} />
                  <div style={{ height: 8, width: `${w + 12}%`, background: "#9ca3af", borderRadius: 3 }} />
                </div>
              </div>
            ))}
            <div style={{ padding: "11px 13px", background: "#f5f3ff", borderRadius: 7, border: "1px solid #ddd6fe", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ height: 11, width: "28%", background: "#7c3aed", borderRadius: 3 }} />
              <div style={{ height: 15, width: "22%", background: "#5b21b6", borderRadius: 3 }} />
            </div>
          </div>
          {/* Right: Chat panel mock */}
          <div style={{ flex: 1, background: "linear-gradient(180deg, #07071a 0%, #0b0920 50%, #0f0c28 100%)", display: "flex", flexDirection: "column", padding: "14px 12px", gap: 9, overflow: "hidden" }}>
            <div style={{ paddingBottom: 10, borderBottom: "1px solid rgba(139,92,246,0.2)", marginBottom: 4 }}>
              <div style={{ height: 11, width: "42%", background: "#c4b5fd", borderRadius: 3, marginBottom: 5 }} />
              <div style={{ height: 8, width: "26%", background: "rgba(196,181,253,0.35)", borderRadius: 3 }} />
            </div>
            {[
              { side: "end",   w: "72%" },
              { side: "start", w: "52%" },
              { side: "end",   w: "58%" },
              { side: "start", w: "44%" },
              { side: "end",   w: "65%" },
              { side: "start", w: "38%" },
            ].map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.side === "start" ? "flex-start" : "flex-end" }}>
                <div style={{
                  padding: "9px 13px", borderRadius: 12,
                  background: m.side === "start" ? "rgba(139,92,246,0.2)" : "rgba(255,255,255,0.08)",
                  width: m.w,
                }}>
                  <div style={{ height: 9, background: "rgba(255,255,255,0.28)", borderRadius: 3, marginBottom: 4 }} />
                  <div style={{ height: 9, width: "65%", background: "rgba(255,255,255,0.18)", borderRadius: 3 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Dark overlay */}
        <div style={{ position: "absolute", inset: 0, background: "rgba(7,7,26,0.72)", pointerEvents: "none" }} />

        {/* ── Main content column ── */}
        <div style={{
          position: "relative", zIndex: 10,
          width: "100%", maxWidth: 440,
          margin: "0 16px",
          display: "flex", flexDirection: "column", alignItems: "stretch",
          maxHeight: "100dvh", overflowY: "auto",
          padding: "24px 0",
          boxSizing: "border-box",
        }}>

          {/* ── Form box ── */}
          <div style={{
            background: "rgba(15,12,40,0.9)", border: "1px solid rgba(139,92,246,0.38)",
            borderRadius: 16, padding: "26px 24px",
            backdropFilter: "blur(20px)",
            boxShadow: "0 8px 48px rgba(0,0,0,0.55)",
            marginBottom: 10,
          }}>
            {/* Header: logo + title */}
            <div style={{ textAlign: "center", marginBottom: 18 }}>
              {guestDraft.logo_url && (
                <img
                  src={guestDraft.logo_url}
                  alt="לוגו"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  style={{ width: 52, height: 52, borderRadius: "50%", objectFit: "contain", border: "2px solid rgba(139,92,246,0.4)", background: "#fff", marginBottom: 8 }}
                />
              )}
              <div style={{ fontSize: "22px", fontWeight: 800, color: "#c4b5fd", letterSpacing: "-0.3px" }}>יוצרים הצעת מחיר בקלות</div>
              <div style={{ fontSize: "13px", color: "rgba(196,181,253,0.55)", marginTop: 5 }}>3 שאלות קצרות ומתחילים</div>
            </div>

            {/* Website scanner */}
            <div style={{ marginBottom: 18 }}>
              <label style={{ display: "block", fontSize: "12px", color: "#a78bfa", marginBottom: 5, fontWeight: 600 }}>
                יש לך אתר? נסרוק אותו אוטומטית
              </label>
              <div style={{ display: "flex", gap: 8, flexDirection: "row-reverse" }}>
                <button
                  onClick={handleScanWebsite}
                  onMouseDown={(e) => e.preventDefault()}
                  disabled={!guestDraft.website.trim() || scanState === "loading"}
                  style={{
                    flexShrink: 0, padding: "10px 14px", borderRadius: 8, border: "none",
                    background: scanState === "done" ? "rgba(52,211,153,0.2)" : guestDraft.website.trim() ? "linear-gradient(135deg,#7c3aed,#a855f7)" : "rgba(139,92,246,0.2)",
                    color: scanState === "done" ? "#34d399" : "#fff",
                    fontSize: "13px", fontWeight: 700, cursor: guestDraft.website.trim() && scanState !== "loading" ? "pointer" : "default",
                    whiteSpace: "nowrap",
                  }}
                >
                  {scanState === "loading" ? "סורק..." : scanState === "done" ? "✓ נסרק" : "סרוק"}
                </button>
                <input
                  type="url"
                  value={guestDraft.website}
                  onChange={(e) => { setGuestDraft((p) => ({ ...p, website: e.target.value })); setScanState("idle"); setScanError(""); setScanResult(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleScanWebsite(); } }}
                  placeholder="yourwebsite.com"
                  style={{
                    flex: 1, padding: "10px 12px", borderRadius: 8, boxSizing: "border-box",
                    background: "rgba(255,255,255,0.06)", border: `1px solid ${scanState === "done" ? "rgba(52,211,153,0.5)" : scanState === "error" ? "rgba(248,113,113,0.5)" : "rgba(139,92,246,0.3)"}`,
                    color: "#e2e8f0", fontSize: "16px", outline: "none", direction: "ltr",
                    fontFamily: "inherit",
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "#a78bfa")}
                  onBlur={(e) => (e.currentTarget.style.borderColor = scanState === "done" ? "rgba(52,211,153,0.5)" : scanState === "error" ? "rgba(248,113,113,0.5)" : "rgba(139,92,246,0.3)")}
                />
              </div>
              {scanState === "error" && scanError && (
                <div style={{ fontSize: 11, color: "#f87171", marginTop: 5 }}>{scanError}</div>
              )}
              {scanState === "done" && scanResult && (
                <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)", display: "flex", alignItems: "center", gap: 10 }}>
                  {scanResult.logo_url && (
                    <img
                      src={scanResult.logo_url}
                      alt="לוגו"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                      style={{ width: 36, height: 36, borderRadius: 6, objectFit: "contain", background: "#fff", flexShrink: 0, border: "1px solid rgba(255,255,255,0.15)" }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {scanResult.company_name && <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", marginBottom: 2 }}>{scanResult.company_name}</div>}
                    <div style={{ fontSize: 11, color: "rgba(196,181,253,0.7)", display: "flex", flexWrap: "wrap", gap: "2px 8px" }}>
                      {scanResult.industry && <span>🏢 {scanResult.industry}</span>}
                      {scanResult.email    && <span>✉ {scanResult.email}</span>}
                      {scanResult.address  && <span>📍 {scanResult.address}</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "#34d399", flexShrink: 0 }}>✓ מולא</div>
                </div>
              )}
            </div>

            {/* Manual fields */}
            {(["company_name", "email", "industry"] as const).map((field) => (
              <div key={field} style={{ marginBottom: 14 }}>
                <label style={{ display: "block", fontSize: "12px", color: "#a78bfa", marginBottom: 5, fontWeight: 600 }}>
                  {field === "company_name" ? "שם חברה" : field === "email" ? "אימייל" : "תחום עיסוק"}
                </label>
                <input
                  type={field === "email" ? "email" : "text"}
                  value={guestDraft[field]}
                  onChange={(e) => setGuestDraft((p) => ({ ...p, [field]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) setGuestInfo({ company_name: guestDraft.company_name, email: guestDraft.email, industry: guestDraft.industry, address: guestDraft.address || undefined, logo_url: guestDraft.logo_url || undefined }); }}
                  placeholder={field === "company_name" ? "למשל: אינסטלציה כהן" : field === "email" ? "your@email.com" : "למשל: אינסטלציה"}
                  style={{
                    width: "100%", padding: "10px 12px", borderRadius: 8, boxSizing: "border-box",
                    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(139,92,246,0.3)",
                    color: "#e2e8f0", fontSize: "16px", outline: "none", direction: "rtl",
                    fontFamily: "inherit",
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "#a78bfa")}
                  onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(139,92,246,0.3)")}
                />
              </div>
            ))}
            <button
              onClick={() => { if (canSubmit) setGuestInfo({ company_name: guestDraft.company_name, email: guestDraft.email, industry: guestDraft.industry, address: guestDraft.address || undefined, logo_url: guestDraft.logo_url || undefined }); }}
              disabled={!canSubmit}
              style={{
                marginTop: 10, width: "100%", padding: "13px 0", borderRadius: 50, border: "none",
                background: canSubmit
                  ? "linear-gradient(135deg, #7c3aed 0%, #a855f7 60%, #ec4899 100%)"
                  : "rgba(139,92,246,0.2)",
                color: "#fff", fontSize: "15px", fontWeight: 700, cursor: canSubmit ? "pointer" : "default",
                boxShadow: canSubmit ? "0 4px 24px rgba(139,92,246,0.45)" : "none",
                transition: "background 0.2s, box-shadow 0.2s",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              <span>🏆</span>
              <span>צרו הצעה מנצחת</span>
            </button>
          </div>

          {/* ── Chat preview card ── */}
          <div style={{
            background: "rgba(5,3,18,0.6)",
            border: "1px solid rgba(99,60,220,0.22)",
            borderRadius: 14,
            padding: "12px 14px",
            backdropFilter: "blur(12px)",
            boxShadow: "0 2px 16px rgba(0,0,0,0.3)",
          }}>
            {/* Chat header */}
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(99,60,220,0.15)" }}>
              <div style={{ width: 24, height: 24, borderRadius: "50%", background: "linear-gradient(135deg,#6d28d9,#db2777)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>🤖</div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa" }}>עוזר הצעות מחיר AI</div>
                <div style={{ fontSize: 9, color: "rgba(167,139,250,0.45)" }}>מחובר ● זמין 24/7</div>
              </div>
            </div>
            {/* Sample conversation */}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", gap: 7, alignItems: "flex-end" }}>
                <div style={{ width: 18, height: 18, borderRadius: "50%", background: "linear-gradient(135deg,#6d28d9,#9333ea)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9 }}>🤖</div>
                <div style={{ background: "rgba(109,40,217,0.18)", borderRadius: "3px 12px 12px 12px", padding: "7px 10px", maxWidth: "82%", fontSize: 12, color: "rgba(226,232,240,0.85)", lineHeight: 1.4, border: "1px solid rgba(109,40,217,0.18)" }}>
                  שלום! ספר לי על הפרויקט ואני אכין הצעה מקצועית מיד ✨
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: "12px 3px 12px 12px", padding: "7px 10px", maxWidth: "78%", fontSize: 12, color: "rgba(226,232,240,0.75)", lineHeight: 1.4, border: "1px solid rgba(255,255,255,0.06)" }}>
                  צריך הצעה לשיפוץ מטבח ברחוב הרצל 5
                </div>
              </div>
              <div style={{ display: "flex", gap: 7, alignItems: "flex-end" }}>
                <div style={{ width: 18, height: 18, borderRadius: "50%", background: "linear-gradient(135deg,#6d28d9,#9333ea)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9 }}>🤖</div>
                <div style={{ background: "rgba(109,40,217,0.18)", borderRadius: "3px 12px 12px 12px", padding: "7px 10px", maxWidth: "82%", fontSize: 12, color: "rgba(226,232,240,0.85)", lineHeight: 1.4, border: "1px solid rgba(109,40,217,0.18)" }}>
                  הכנתי טיוטת הצעה — בדוק אותה 📋 מה שם הלקוח?
                </div>
              </div>
            </div>
          </div>

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
      background: "linear-gradient(180deg, #07071a 0%, #0b0920 50%, #0f0c28 100%)",
      overflow: "hidden",
    }}>

      {/* ── Mobile nav button ─────────────────────────────────────────────── */}
      {isMobile && hasQuote && (
        <div dir="rtl" style={{
          flexShrink: 0,
          padding: "8px 14px",
          background: "rgba(7,7,26,0.97)",
          borderBottom: "1px solid rgba(139,92,246,0.2)",
        }}>
          {mobileView === "chat" ? (
            <button onClick={() => setMobileView("preview")} style={{
              width: "100%", padding: "10px 0", borderRadius: 50, border: "none",
              background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 60%, #ec4899 100%)",
              color: "#fff", fontSize: "15px", fontWeight: 700, cursor: "pointer",
              boxShadow: "0 2px 16px rgba(139,92,246,0.4)", letterSpacing: 0.2,
            }}>
              📋 צפה בטיוטה ←
            </button>
          ) : (
            <button onClick={() => setMobileView("chat")} style={{
              width: "100%", padding: "10px 0", borderRadius: 50,
              border: "1px solid rgba(139,92,246,0.7)",
              background: "rgba(139,92,246,0.15)",
              color: "#c4b5fd", fontSize: "15px", fontWeight: 800, cursor: "pointer",
              animation: "pulse-glow 2s ease-in-out infinite",
            }}>
              ← חזרה לשיחה
            </button>
          )}
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
            onUpdateTotal={handleUpdateTotal}
            onUpdateAddress={handleUpdateAddress}
            onBackToChat={isMobile ? () => setMobileView("chat") : undefined}
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
              ref={textareaRef}
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
                fontSize: "16px",
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
              onMouseDown={(e) => e.preventDefault()}
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
      {approveState === "success" && (
        <div dir="rtl" style={{
          position: "fixed", inset: 0, zIndex: 50,
          background: "rgba(7,7,26,0.88)",
          backdropFilter: "blur(10px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <style>{`
            @keyframes spin-ring { to { transform: rotate(360deg); } }
            @keyframes progress-fill { from { width: 0% } to { width: 100% } }
            @keyframes float-sparkle {
              0%, 100% { transform: translateY(0) scale(1); opacity: 1; }
              50% { transform: translateY(-6px) scale(1.08); opacity: 0.85; }
            }
            @keyframes fade-cycle-1 { 0%,28%{opacity:1} 33%,100%{opacity:0} }
            @keyframes fade-cycle-2 { 0%,33%{opacity:0} 38%,61%{opacity:1} 66%,100%{opacity:0} }
            @keyframes fade-cycle-3 { 0%,66%{opacity:0} 71%,94%{opacity:1} 100%{opacity:0} }
          `}</style>
          <div style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(139,92,246,0.35)",
            borderRadius: 20, padding: "32px 28px",
            maxWidth: 380, width: "90%", textAlign: "center",
          }}>
            {/* Header */}
            <div style={{ fontSize: 38, marginBottom: 6, animation: "float-sparkle 2.5s ease-in-out infinite" }}>✨</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#c4b5fd", marginBottom: 18 }}>ההצעה נשמרה!</div>

            {/* Creating animation */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 10 }}>
                <div style={{
                  width: 20, height: 20, borderRadius: "50%",
                  border: "2.5px solid rgba(139,92,246,0.25)",
                  borderTopColor: "#a78bfa",
                  animation: "spin-ring 0.85s linear infinite",
                  flexShrink: 0,
                }} />
                <div style={{ position: "relative", height: 20, minWidth: 170 }}>
                  <span style={{ position: "absolute", right: 0, left: 0, fontSize: 13, color: "#c4b5fd", animation: "fade-cycle-1 9s linear infinite" }}>
                    מנתח את הנתונים...
                  </span>
                  <span style={{ position: "absolute", right: 0, left: 0, fontSize: 13, color: "#c4b5fd", animation: "fade-cycle-2 9s linear infinite" }}>
                    בונה את ההצעה שלך...
                  </span>
                  <span style={{ position: "absolute", right: 0, left: 0, fontSize: 13, color: "#c4b5fd", animation: "fade-cycle-3 9s linear infinite" }}>
                    מכין לייצוא...
                  </span>
                </div>
              </div>
              {/* Progress bar */}
              <div dir="ltr" style={{ background: "rgba(139,92,246,0.15)", borderRadius: 4, height: 5, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  background: "linear-gradient(90deg, #7c3aed, #a855f7, #ec4899)",
                  borderRadius: 4,
                  animation: "progress-fill 10s linear forwards",
                }} />
              </div>
            </div>

            {/* Review section */}
            {!reviewSubmitted ? (
              <>
                <div style={{ fontSize: 13, color: "rgba(196,181,253,0.6)", marginBottom: 10 }}>
                  בינתיים — ספר לנו כיצד היה התהליך
                </div>
                <div style={{ fontSize: 14, color: "#c4b5fd", marginBottom: 12, fontWeight: 600 }}>
                  איך היה תהליך יצירת ההצעה?
                </div>
                {/* Stars with emoji hints */}
                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, marginBottom: 14 }}>
                  <span style={{ fontSize: 20, flexShrink: 0 }}>😞</span>
                  {[1,2,3,4,5].map((s) => (
                    <span
                      key={s}
                      onClick={() => setReviewStars(s)}
                      style={{
                        fontSize: 26,
                        cursor: "pointer",
                        color: s <= reviewStars ? "#fbbf24" : "rgba(196,181,253,0.25)",
                        transition: "color 0.15s, transform 0.1s",
                        transform: s <= reviewStars ? "scale(1.15)" : "scale(1)",
                        display: "inline-block",
                        userSelect: "none",
                      }}
                    >★</span>
                  ))}
                  <span style={{ fontSize: 20, flexShrink: 0 }}>😊</span>
                </div>
                <textarea
                  value={reviewComment}
                  onChange={(e) => setReviewComment(e.target.value)}
                  placeholder="הערה (לא חובה)"
                  rows={2}
                  style={{
                    width: "100%", borderRadius: 8, padding: "8px 10px",
                    background: "rgba(255,255,255,0.07)", border: "1px solid rgba(139,92,246,0.3)",
                    color: "#e2e8f0", fontSize: 13, resize: "none", direction: "rtl",
                    fontFamily: "inherit", outline: "none", boxSizing: "border-box",
                    marginBottom: 12,
                  }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={handleReviewSubmit}
                    style={{
                      flex: 1, padding: "10px 0", borderRadius: 50, border: "none",
                      background: reviewStars > 0
                        ? "linear-gradient(135deg, #7c3aed, #a855f7)"
                        : "rgba(139,92,246,0.2)",
                      color: "#fff", fontSize: 14, fontWeight: 700,
                      cursor: reviewStars > 0 ? "pointer" : "default",
                    }}
                  >
                    שלח ביקורת
                  </button>
                  <button
                    onClick={() => setReviewSubmitted(true)}
                    style={{
                      flex: 1, padding: "10px 0", borderRadius: 50,
                      border: "1px solid rgba(139,92,246,0.3)",
                      background: "transparent",
                      color: "rgba(196,181,253,0.6)", fontSize: 14, cursor: "pointer",
                    }}
                  >
                    דלג
                  </button>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 22, color: "#c4b5fd" }}>תודה! 🙏</div>
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
  onUpdateTotal,
  onUpdateAddress,
  onBackToChat,
}: {
  quote: Partial<Quote>;
  companyName: string;
  companyLogo?: string;
  onApprove: () => void;
  approveState: "idle" | "loading" | "success" | "error";
  onTitleChange: (title: string) => void;
  onDeleteItem: (index: number) => void;
  onUpdateItem: (index: number, name: string, description: string) => void;
  onUpdateTerms: (terms: string) => void;
  onUpdateComments: (comments: string) => void;
  onUpdateTotal: (total: number) => void;
  onUpdateAddress: (address: string) => void;
  onBackToChat?: () => void;
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

  const [editingTotal, setEditingTotal] = useState(false);
  const [totalDraft, setTotalDraft] = useState("");

  const [editingAddress, setEditingAddress] = useState(false);
  const [addressDraft, setAddressDraft] = useState("");

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
            {quote.client?.name && <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827" }}>{quote.client.name}</div>}
            {/* Address — always editable */}
            {editingAddress ? (
              <input
                autoFocus
                value={addressDraft}
                onChange={(e) => setAddressDraft(e.target.value)}
                onBlur={() => { setEditingAddress(false); if (addressDraft.trim()) onUpdateAddress(addressDraft.trim()); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingAddress(false); }}
                placeholder="הוסף כתובת"
                style={{ ...editInputStyle, fontSize: "12px", marginTop: 3 }}
              />
            ) : (
              <div
                onClick={() => { setAddressDraft(quote.client?.address ?? ""); setEditingAddress(true); }}
                title="לחץ לעריכה"
                style={{ fontSize: "12px", color: quote.client?.address ? "#6b7280" : "#a78bfa", marginTop: 3, cursor: "pointer" }}
              >
                {quote.client?.address || "הוסף כתובת ✏️"}
              </div>
            )}
            {quote.client?.phone && <div style={{ fontSize: "12px", color: "#6b7280", marginTop: 2 }}>{quote.client.phone}</div>}
            {quote.client?.email && <div style={{ fontSize: "12px", color: "#6b7280", marginTop: 2 }}>{quote.client.email}</div>}
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
              <span style={{ fontSize: "13px", color: "#7c3aed", fontWeight: 600 }}>סה&quot;כ לתשלום</span>
              {editingTotal ? (
                <input
                  autoFocus
                  type="number"
                  value={totalDraft}
                  onChange={(e) => setTotalDraft(e.target.value)}
                  onBlur={() => {
                    setEditingTotal(false);
                    const n = parseFloat(totalDraft);
                    if (!isNaN(n) && n > 0) onUpdateTotal(n);
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingTotal(false); }}
                  style={{ fontSize: "18px", fontWeight: 800, width: 110, textAlign: "right", border: "1px solid #a78bfa", borderRadius: 4, padding: "2px 6px", color: "#5b21b6", outline: "none", fontFamily: "inherit" }}
                />
              ) : (
                <span
                  onClick={() => { setTotalDraft(quote.total && quote.total > 0 ? String(quote.total) : ""); setEditingTotal(true); }}
                  title="לחץ לעריכה"
                  style={{ fontSize: "20px", fontWeight: 800, color: quote.total > 0 ? "#5b21b6" : "#a78bfa", cursor: "pointer" }}
                >
                  {quote.total > 0 ? formatILS(quote.total) : "מחיר יעודכן ✏️"}
                </span>
              )}
            </div>
            {quote.has_tax !== undefined && (
              <div style={{ fontSize: "11px", color: "#8b5cf6", marginTop: 6, textAlign: "left" }}>
                {quote.has_tax ? 'כולל מע״מ' : 'ללא מע״מ'}
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
        const hasItems      = (quote.items?.length ?? 0) > 0;
        const hasTotal      = (quote.total ?? 0) > 0;
        const hasTitle      = !!quote.title?.trim();
        const hasClientName = !!quote.client?.name?.trim();
        const canApprove    = hasItems && hasTotal && hasTitle && hasClientName;
        const isBusy = approveState === "loading" || approveState === "success";
        const helperText = !canApprove
          ? (!hasItems      ? "ממתין לפריטי עבודה..."
           : !hasTotal      ? "עדכן מחיר כדי להמשיך"
           : !hasClientName ? "חסר שם לקוח"
           : "חסרה כותרת להצעה")
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
              onClick={() => {
                if (isBusy) return;
                if (canApprove) onApprove();
                else onBackToChat?.();
              }}
              disabled={isBusy}
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
                cursor: !isBusy ? "pointer" : "default",
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
