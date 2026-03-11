"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { AIContext } from "@/lib/verifyToken";
import type { Quote, PartialQuote } from "@/lib/quoteSchema";
import { useTheme } from "@/contexts/ThemeContext";

// ── Loader animation ──────────────────────────────────────────────────────────
function QuoteLoader() {
  return (
    <>
      <style>{`
        @keyframes ql-dot {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          40%, 60%  { opacity: 1;   transform: scale(1.2); }
        }
        .ql-d  { animation: ql-dot 1.4s ease-in-out infinite; border-radius: 50%; width: 8px; height: 8px; background: rgba(var(--purple-rgb), 0.8); display: inline-block; margin: 0 3px; }
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

  const { theme, toggle } = useTheme();

  // ── Guest state ───────────────────────────────────────────────────────────
  const [guestInfo, setGuestInfo] = useState<{ company_name: string; address: string; phone: string; email: string } | null>(null);
  const [guestReady, setGuestReady] = useState(false);
  // step: 0=waiting for work description, 1=waiting for business name (after draft built)
  const [guestStep, setGuestStep] = useState<0|1>(0);
  const [guestBusinessName, setGuestBusinessName] = useState("");
  const guestDraftRef = useRef({ company_name: "", address: "", phone: "" });
  const [submitChecking, setSubmitChecking] = useState(false);
  const [emailExistsAlert, setEmailExistsAlert] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [guestLogoUrl, setGuestLogoUrl] = useState<string | undefined>();

  const effectiveContext: (AIContext & { user_id?: string }) | undefined =
    aiContext ?? (guestInfo ? {
      company_name: guestInfo.company_name,
      industry:     quote.industry ?? "כללי",
      company_info: [
        guestInfo.address && `כתובת: ${guestInfo.address}`,
        guestInfo.phone   && `טלפון: ${guestInfo.phone}`,
        guestInfo.email   && `אימייל: ${guestInfo.email}`,
      ].filter(Boolean).join(" | ") || undefined,
      company_logo: guestLogoUrl,
    } : (guestReady || guestStep === 1) ? {
      // Draft phase or business-name step: use captured name or fallback
      company_name: guestBusinessName || "העסק שלך",
      industry: quote.industry ?? "כללי",
      company_logo: guestLogoUrl,
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

  // Guest: show first onboarding question on mount
  useEffect(() => {
    if (!isGuest) return;
    setMessages([{
      role: "assistant",
      content: "שלום! 👋 ספר לנו בקצרה על העבודה או השירות שתרצה להציע עבורו הצעת מחיר.",
    }]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Existing users (JWT) or after guest onboarding completes
  useEffect(() => {
    if (!effectiveContext) return;
    if (isGuest) return; // guest flow manages its own messages
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

  // ── Guest step-by-step onboarding ─────────────────────────────────────────
  const handleGuestStepAnswer = useCallback(async (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed) return;

    if (guestStep === 0) {
      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      // User described work → call AI to build draft, then ask for business name
      setGuestStep(1);
      setMessages((prev) => [...prev, { role: "assistant", content: "", loading: true }]);
      setIsLoading(true);
      try {
        const tempCtx: AIContext = { company_name: "העסק שלך", industry: "" };
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: trimmed }], aiContext: tempCtx, currentQuote: {}, token }),
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
              const event = JSON.parse(line.slice(6)) as { type: string; content?: string; quote?: PartialQuote };
              if (event.type === "text" && event.content) {
                assistantText += event.content + " ";
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === "assistant") updated[updated.length - 1] = { ...last, content: assistantText.trim(), loading: false };
                  return updated;
                });
              } else if (event.type === "quote_update" && event.quote) {
                setQuote((prev) => mergeQuote(prev, event.quote!));
                setMobileView("preview");
              }
            } catch { /* ignore */ }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") updated[updated.length - 1] = { ...last, content: `שגיאה: ${msg}`, loading: false };
          return updated;
        });
      } finally {
        setIsLoading(false);
      }
      setMessages((prev) => [
        ...prev.filter((m) => !m.loading),
        { role: "assistant", content: "מעולה! ולפני שנמשיך — מה שם העסק שלך? נוסיף אותו להצעה." },
      ]);
      // guestReady stays false — waiting for business name in step 1

    } else if (guestStep === 1) {
      // User provided their business name → store it, unlock free chat
      setGuestBusinessName(trimmed);
      setPreApproveDraft((p) => ({ ...p, company_name: trimmed }));
      setGuestReady(true);
      // Let AI acknowledge and continue naturally
      sendMessage(trimmed, quote);
    }
  }, [guestStep, token, quote, sendMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isLoading || submitChecking) return;
    setInput("");
    if (isGuest && !guestReady) {
      handleGuestStepAnswer(text);
    } else {
      sendMessage(text, quote);
    }
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [input, isLoading, submitChecking, isGuest, guestInfo, quote, sendMessage, handleGuestStepAnswer]);

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
  const pendingApproveRef = useRef<{ company_name: string; address: string; phone: string; email: string } | null>(null);
  const [preApproveVisible, setPreApproveVisible] = useState(false);
  const [preApproveDraft, setPreApproveDraft] = useState({ company_name: "", address: "", phone: "", email: "" });
  const [preApproveChecking, setPreApproveChecking] = useState(false);
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
    // Guests who haven't filled in account details yet → show pre-approve form first
    const effectiveGuestInfo = guestInfo ?? pendingApproveRef.current;
    if (isGuest && !effectiveGuestInfo) {
      setPreApproveVisible(true);
      return;
    }

    setApproveState("loading");
    try {
      let res: Response;
      const quoteWithTax = { ...quote, has_tax: quote.has_tax ?? false };
      if (isGuest && effectiveGuestInfo) {
        // Guard: re-check email before submitting
        try {
          const emailCheck = await fetch("/api/check-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: effectiveGuestInfo.email }),
          });
          const emailData = await emailCheck.json() as { exists: boolean };
          if (emailData.exists) {
            setApproveState("idle");
            setEmailExistsAlert(true);
            setTimeout(() => { window.location.href = "https://app.tik-tok.co.il"; }, 3200);
            return;
          }
        } catch { /* on error, proceed — never block the user */ }

        res = await fetch("/api/onboard-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            company_name:  effectiveGuestInfo.company_name,
            email:         effectiveGuestInfo.email,
            industry:      quote.industry ?? "כללי",
            address:       effectiveGuestInfo.address,
            company_phone: effectiveGuestInfo.phone,
            logo_url:      guestLogoUrl,
            quote:         quoteWithTax,
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
            // New user: always redirect directly (not in iframe)
            if (guestRedirectUrl) {
              window.location.href = guestRedirectUrl;
            } else {
              setApproveState("idle"); // no redirect URL — release overlay so user isn't stuck
            }
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
  }, [aiContext, isGuest, guestInfo, quote, guestLogoUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pre-approve form submit ────────────────────────────────────────────────
  const handlePreApproveSubmit = useCallback(async () => {
    const { company_name, email, address, phone } = preApproveDraft;
    if (!company_name.trim() || !email.trim()) return;
    setPreApproveChecking(true);
    try {
      const emailCheck = await fetch("/api/check-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const emailData = await emailCheck.json() as { exists: boolean };
      if (emailData.exists) {
        setPreApproveChecking(false);
        setPreApproveVisible(false);
        setEmailExistsAlert(true);
        setTimeout(() => { window.location.href = "https://app.tik-tok.co.il"; }, 3200);
        return;
      }
    } catch { /* on error, proceed */ }
    const info = { company_name: company_name.trim(), email: email.trim(), address: address.trim(), phone: phone.trim() };
    pendingApproveRef.current = info;
    setGuestInfo(info);
    setPreApproveChecking(false);
    setPreApproveVisible(false);
    // Call handleApprove — it will pick up info from pendingApproveRef since state update is async
    setTimeout(() => handleApprove(), 0);
  }, [preApproveDraft, handleApprove]); // eslint-disable-line react-hooks/exhaustive-deps


  return (
    // Outer: column flex — tab bar on top (mobile), panels row below
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100dvh",
      background: "linear-gradient(180deg, var(--bg-base) 0%, var(--bg-mid) 50%, var(--bg-end) 100%)",
      overflow: "hidden",
    }}>

      {/* ── Mobile nav button ─────────────────────────────────────────────── */}
      {isMobile && hasQuote && (
        <div dir="rtl" style={{
          flexShrink: 0,
          padding: "8px 14px",
          background: "#ffffff",
          borderBottom: "1px solid #e8eaed",
        }}>
          {mobileView === "chat" ? (
            <button onClick={() => setMobileView("preview")} style={{
              width: "100%", padding: "10px 0", borderRadius: 50, border: "none",
              background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 60%, #ec4899 100%)",
              color: "#fff", fontSize: "15px", fontWeight: 700, cursor: "pointer",
              boxShadow: `0 2px 16px rgba(var(--purple-rgb), 0.4)`, letterSpacing: 0.2,
            }}>
              📋 צפה בטיוטה ←
            </button>
          ) : (
            <div style={{ display: "flex", justifyContent: "center" }}>
              <button onClick={() => setMobileView("chat")} style={{
                padding: "8px 24px", borderRadius: 50,
                border: `1px solid rgba(var(--purple-rgb), 0.6)`,
                background: `rgba(var(--purple-rgb), 0.12)`,
                color: "var(--text-secondary)", fontSize: "13px", fontWeight: 700, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 7,
                animation: "pulse-glow 2s ease-in-out infinite",
              }}>
                <span>💬</span>
                <span>חזרה לשיחה</span>
              </button>
            </div>
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
            isGuest={isGuest}
            termsAccepted={termsAccepted}
            onTermsChange={setTermsAccepted}
            onLogoUpload={setGuestLogoUrl}
          />
        )}
        {/* Decorative chat input — mobile preview only — tapping returns to chat */}
        {isMobile && mobileView === "preview" && (
          <div
            dir="rtl"
            onClick={() => setMobileView("chat")}
            style={{
              flexShrink: 0,
              padding: "8px 14px 12px",
              borderTop: "1px solid #e8eaed",
              background: "#ffffff",
              cursor: "pointer",
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              background: "#f8f9fa",
              border: "1px solid #e2e6ea",
              borderRadius: 24, padding: "9px 12px",
              animation: "pulse-glow 2.5s ease-in-out infinite",
            }}>
              <div style={{
                flexShrink: 0, width: 34, height: 34, borderRadius: "50%",
                background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
                color: "#fff", display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: "18px",
              }}>←</div>
              <div style={{
                flex: 1, color: "#9ca3af", fontSize: "15px",
                direction: "rtl", textAlign: "right",
              }}>
                תאר את העבודה...
              </div>
              <div style={{
                flexShrink: 0, width: 34, height: 34, borderRadius: "50%",
                border: "1px solid #e2e6ea",
                background: "#f3f4f6", color: "#6d28d9",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px",
              }}>🎙</div>
            </div>
          </div>
        )}
      </div>

      {/* ── RIGHT: Chat panel ─────────────────────────────────────────────── */}
      <div dir="rtl" style={{
        flex: 1,
        display: isMobile && hasQuote && mobileView === "preview" ? "none" : "flex",
        flexDirection: "column",
        minWidth: 0,
        background: "#ffffff",
        color: "#1a1a2e",
      }}>

        {/* Header */}
        <div style={{
          padding: "14px 20px",
          borderBottom: "1px solid #e8eaed",
          background: "#ffffff",
          textAlign: "right",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexDirection: "row-reverse",
        }}>
          <div style={{ flex: 1, textAlign: "right" }}>
            <div style={{ fontSize: "15px", fontWeight: 600, color: "#1a1a2e" }}>{effectiveContext?.company_name ?? (isGuest ? "תיקתוק הצעות מחיר" : "")}</div>
            <div style={{ fontSize: "12px", color: "#6d28d9", marginTop: 2 }}>{effectiveContext?.industry ?? (isGuest ? "תוך 30 שניות יש לכם הצעת מחיר פצצה" : "")}</div>
          </div>
          <button
            onClick={toggle}
            title={theme === 'dark' ? 'עבור למצב בהיר' : 'עבור למצב כהה'}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              padding: '6px',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {theme === 'dark' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px", display: "flex", flexDirection: "column", gap: 16 }}>


          {messages.map((msg, i) => (
            <div key={i} style={{
              display: "flex",
              // RTL: flex-start = right side, flex-end = left side
              justifyContent: msg.role === "user" ? "flex-start" : "flex-end",
            }}>
              {msg.role === "user" ? (
                <div style={{
                  maxWidth: "72%",
                  padding: "12px 18px",
                  borderRadius: 22,
                  background: "#eef1ff",
                  fontSize: "15px",
                  lineHeight: 1.65,
                  color: "#1a1a2e",
                  wordBreak: "break-word",
                  textAlign: "right",
                }}>
                  {msg.content}
                </div>
              ) : (
                <div style={{
                  display: "flex", gap: 10, alignItems: "flex-start", maxWidth: "90%",
                  background: "#f5f0ff", borderRadius: 18, padding: "10px 14px",
                }}>
                  {/* In RTL flex, first child = right side → icon appears to the right of text */}
                  <div style={{
                    flexShrink: 0, width: 28, height: 28, borderRadius: "50%",
                    background: "linear-gradient(135deg, #7c3aed, #a855f7)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    marginTop: 2,
                  }}>
                    <SparkleIcon />
                  </div>
                  <div style={{
                    flex: 1, fontSize: "15px", lineHeight: 1.75,
                    color: "#1a1a2e", textAlign: "right", paddingTop: 2,
                    wordBreak: "break-word",
                  }}>
                    {msg.loading ? <QuoteLoader /> : msg.content}
                  </div>
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Landing chips — only before first quote and after guest onboarding done */}
        {!hasQuote && (!isGuest || guestReady) && (
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
          padding: "8px 16px 16px",
          background: "transparent",
          position: "relative",
        }}>
          <div style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 8,
            background: "#ffffff",
            border: "1px solid #e2e6ea",
            borderRadius: 28,
            padding: "10px 14px",
            boxShadow: "0 1px 8px rgba(0,0,0,0.07)",
          }}>
            {/* Mic — LEFT in JSX = RIGHT in RTL */}
            <button
              onClick={handleVoice}
              disabled={isLoading || submitChecking}
              title={isListening ? "עצור הקלטה" : "הקלד בקול"}
              style={{
                flexShrink: 0,
                width: 34,
                height: 34,
                borderRadius: "50%",
                border: isListening ? "1px solid rgba(239,68,68,0.5)" : "1px solid #e2e6ea",
                background: isListening ? "rgba(239,68,68,0.1)" : "transparent",
                color: isListening ? "#ef4444" : "#6d28d9",
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
                color: "#1a1a2e",
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
              disabled={isLoading || submitChecking || !input.trim()}
              style={{
                flexShrink: 0,
                width: 34,
                height: 34,
                borderRadius: "50%",
                border: "none",
                background: input.trim() && !isLoading && !submitChecking
                  ? "linear-gradient(135deg, #7c3aed, #6d28d9)"
                  : "#e8eaed",
                color: input.trim() && !isLoading && !submitChecking ? "#fff" : "#9ca3af",
                cursor: input.trim() && !isLoading && !submitChecking ? "pointer" : "default",
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

      {/* ── Pre-approve form overlay ── */}
      {preApproveVisible && (
        <div dir="rtl" style={{
          position: "fixed", inset: 0, zIndex: 55,
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(6px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "#ffffff", borderRadius: 20, padding: "28px 24px",
            maxWidth: 380, width: "92%",
            boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
          }}>
            <div style={{ fontSize: "18px", fontWeight: 700, color: "#1a1a2e", marginBottom: 6, textAlign: "right" }}>
              פתיחת חשבון חינמי
            </div>
            <div style={{ fontSize: "13px", color: "#6d28d9", marginBottom: 20, textAlign: "right" }}>
              ממלאים פרטים ושולחים — ההצעה נשמרת ישר אצלכם
            </div>

            {/* Company name */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#374151", marginBottom: 4, textAlign: "right" }}>
                שם העסק *
              </label>
              <input
                type="text"
                value={preApproveDraft.company_name}
                onChange={(e) => setPreApproveDraft((p) => ({ ...p, company_name: e.target.value }))}
                placeholder="למשל: אינסטלציה ישראל"
                style={{
                  width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db",
                  fontSize: "15px", direction: "rtl", fontFamily: "inherit", outline: "none",
                  boxSizing: "border-box", color: "#1a1a2e",
                }}
              />
            </div>

            {/* Email */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#374151", marginBottom: 4, textAlign: "right" }}>
                אימייל *
              </label>
              <input
                type="email"
                value={preApproveDraft.email}
                onChange={(e) => setPreApproveDraft((p) => ({ ...p, email: e.target.value }))}
                placeholder="you@example.com"
                style={{
                  width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db",
                  fontSize: "15px", direction: "ltr", fontFamily: "inherit", outline: "none",
                  boxSizing: "border-box", color: "#1a1a2e", textAlign: "left",
                }}
              />
            </div>

            {/* Phone */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#374151", marginBottom: 4, textAlign: "right" }}>
                טלפון
              </label>
              <input
                type="tel"
                value={preApproveDraft.phone}
                onChange={(e) => setPreApproveDraft((p) => ({ ...p, phone: e.target.value }))}
                placeholder="050-0000000"
                style={{
                  width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db",
                  fontSize: "15px", direction: "ltr", fontFamily: "inherit", outline: "none",
                  boxSizing: "border-box", color: "#1a1a2e", textAlign: "left",
                }}
              />
            </div>

            {/* Address */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#374151", marginBottom: 4, textAlign: "right" }}>
                כתובת
              </label>
              <input
                type="text"
                value={preApproveDraft.address}
                onChange={(e) => setPreApproveDraft((p) => ({ ...p, address: e.target.value }))}
                placeholder="רחוב הרצל 1, תל אביב"
                style={{
                  width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db",
                  fontSize: "15px", direction: "rtl", fontFamily: "inherit", outline: "none",
                  boxSizing: "border-box", color: "#1a1a2e",
                }}
              />
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={handlePreApproveSubmit}
                disabled={preApproveChecking || !preApproveDraft.company_name.trim() || !preApproveDraft.email.trim()}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 50, border: "none",
                  background: preApproveChecking || !preApproveDraft.company_name.trim() || !preApproveDraft.email.trim()
                    ? "#e5e7eb" : "linear-gradient(135deg, #7c3aed, #a855f7)",
                  color: preApproveChecking || !preApproveDraft.company_name.trim() || !preApproveDraft.email.trim()
                    ? "#9ca3af" : "#fff",
                  fontSize: "15px", fontWeight: 700,
                  cursor: preApproveChecking || !preApproveDraft.company_name.trim() || !preApproveDraft.email.trim() ? "default" : "pointer",
                  transition: "background 0.2s",
                }}
              >
                {preApproveChecking ? "בודק..." : "שמור ושלח הצעה"}
              </button>
              <button
                onClick={() => setPreApproveVisible(false)}
                disabled={preApproveChecking}
                style={{
                  padding: "12px 18px", borderRadius: 50,
                  border: "1px solid #e5e7eb", background: "transparent",
                  color: "#9ca3af", fontSize: "14px", cursor: "pointer",
                }}
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Email-exists alert overlay ── */}
      {emailExistsAlert && (
        <div dir="rtl" style={{
          position: "fixed", inset: 0, zIndex: 60,
          background: `rgba(var(--bg-base), 0.85)`,
          backdropFilter: "blur(12px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <style>{`
            @keyframes email-progress { from { width: 0% } to { width: 100% } }
            @keyframes email-pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.1)} }
          `}</style>
          <div style={{
            background: `linear-gradient(160deg, rgba(var(--card-bg-start-rgb), 0.18) 0%, rgba(var(--card-bg-end-rgb), 0.98) 100%)`,
            border: `1px solid rgba(var(--purple-rgb), 0.5)`,
            borderRadius: 22, padding: "36px 28px 28px",
            maxWidth: 360, width: "90%", textAlign: "center",
            boxShadow: `0 0 60px rgba(var(--purple-rgb), 0.25), 0 16px 48px rgba(var(--black-overlay-rgb), 0.7)`,
          }}>
            <div style={{ fontSize: 42, marginBottom: 14, animation: "email-pulse 2s ease-in-out infinite" }}>✉️</div>
            <div style={{ fontSize: "19px", fontWeight: 800, color: "var(--text-heading)", marginBottom: 10, lineHeight: 1.4 }}>
              המייל כבר קיים במערכת
            </div>
            <div style={{ fontSize: "14px", color: `rgba(var(--purple-light-rgb), 0.7)`, lineHeight: 1.65, marginBottom: 24 }}>
              אנחנו רואים שהמייל הזה כבר קיים אצלנו —<br />
              מעבירים אותך לעמוד התחברות
            </div>
            {/* Progress bar */}
            <div dir="ltr" style={{ background: `rgba(var(--purple-rgb), 0.15)`, borderRadius: 4, height: 5, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                background: "linear-gradient(90deg, #7c3aed, #a855f7, #ec4899)",
                borderRadius: 4,
                animation: "email-progress 3.2s linear forwards",
              }} />
            </div>
          </div>
        </div>
      )}

      {/* ── Post-approve overlay ── */}
      {approveState === "success" && (
        <div dir="rtl" style={{
          position: "fixed", inset: 0, zIndex: 50,
          background: `rgba(var(--bg-base), 0.88)`,
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
            background: `rgba(var(--white-overlay-rgb), 0.05)`,
            border: `1px solid rgba(var(--purple-rgb), 0.35)`,
            borderRadius: 20, padding: "32px 28px",
            maxWidth: 380, width: "90%", textAlign: "center",
          }}>
            {/* Header */}
            <div style={{ fontSize: 38, marginBottom: 6, animation: "float-sparkle 2.5s ease-in-out infinite" }}>✨</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text-secondary)", marginBottom: 18 }}>ההצעה נשמרה!</div>

            {/* Creating animation */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 10 }}>
                <div style={{
                  width: 20, height: 20, borderRadius: "50%",
                  border: `2.5px solid rgba(var(--purple-rgb), 0.25)`,
                  borderTopColor: "var(--text-accent)",
                  animation: "spin-ring 0.85s linear infinite",
                  flexShrink: 0,
                }} />
                <div style={{ position: "relative", height: 20, minWidth: 170 }}>
                  <span style={{ position: "absolute", right: 0, left: 0, fontSize: 13, color: "var(--text-secondary)", animation: "fade-cycle-1 9s linear infinite" }}>
                    מנתח את הנתונים...
                  </span>
                  <span style={{ position: "absolute", right: 0, left: 0, fontSize: 13, color: "var(--text-secondary)", animation: "fade-cycle-2 9s linear infinite" }}>
                    בונה את ההצעה שלך...
                  </span>
                  <span style={{ position: "absolute", right: 0, left: 0, fontSize: 13, color: "var(--text-secondary)", animation: "fade-cycle-3 9s linear infinite" }}>
                    מכין לייצוא...
                  </span>
                </div>
              </div>
              {/* Progress bar */}
              <div dir="ltr" style={{ background: `rgba(var(--purple-rgb), 0.15)`, borderRadius: 4, height: 5, overflow: "hidden" }}>
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
                <div style={{ fontSize: 13, color: `rgba(var(--purple-light-rgb), 0.6)`, marginBottom: 10 }}>
                  בינתיים — ספר לנו כיצד היה התהליך
                </div>
                <div style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 12, fontWeight: 600 }}>
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
                        color: s <= reviewStars ? "#fbbf24" : `rgba(var(--purple-light-rgb), 0.25)`,
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
                    background: `rgba(var(--white-overlay-rgb), 0.07)`, border: `1px solid rgba(var(--purple-rgb), 0.3)`,
                    color: "var(--text-primary)", fontSize: 13, resize: "none", direction: "rtl",
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
                        : `rgba(var(--purple-rgb), 0.2)`,
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
                      border: `1px solid rgba(var(--purple-rgb), 0.3)`,
                      background: "transparent",
                      color: `rgba(var(--purple-light-rgb), 0.6)`, fontSize: 14, cursor: "pointer",
                    }}
                  >
                    דלג
                  </button>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 22, color: "var(--text-secondary)" }}>תודה! 🙏</div>
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
  primaryColor,
  accentColor,
  isGuest,
  termsAccepted,
  onTermsChange,
  onLogoUpload,
}: {
  quote: Partial<Quote>;
  companyName: string;
  companyLogo?: string;
  primaryColor?: string;
  accentColor?: string;
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
  isGuest?: boolean;
  termsAccepted?: boolean;
  onTermsChange?: (v: boolean) => void;
  onLogoUpload?: (url: string) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const [editingItemIdx, setEditingItemIdx] = useState<number | null>(null);
  const [itemNameDraft, setItemNameDraft] = useState("");
  const [itemDescDraft, setItemDescDraft] = useState("");

  const [editingTerms, setEditingTerms] = useState(false);
  const [termsDraft, setTermsDraft] = useState("");

  const primary      = primaryColor || "#7c3aed";
  const accent       = accentColor  || "#a855f7";
  const primaryLight = primary + "26";

  const [editingComments, setEditingComments] = useState(false);
  const [commentsDraft, setCommentsDraft] = useState("");

  const [editingTotal, setEditingTotal] = useState(false);
  const [totalDraft, setTotalDraft] = useState("");

  const [editingAddress, setEditingAddress] = useState(false);
  const [addressDraft, setAddressDraft] = useState("");

  const [logoUploading, setLogoUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const handleLogoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !onLogoUpload) return;
    setLogoUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload-logo", { method: "POST", body: fd });
      const data = await res.json() as { ok: boolean; url?: string };
      if (data.ok && data.url) {
        onLogoUpload(data.url);
        console.log("[logo] uploaded:", data.url);
      }
    } catch (err) {
      console.error("[logo] upload failed:", err);
    } finally {
      setLogoUploading(false);
    }
  };

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
      .qp-spinner { width: 36px; height: 36px; border: 3px solid rgba(196,181,253,0.2); border-top-color: ${accent}; border-radius: 50%; animation: qp-spin 0.8s linear infinite; margin: 0 auto; }
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
          {/* Logo area — clickable for guests */}
          <div
            onClick={() => isGuest && logoInputRef.current?.click()}
            title={isGuest ? (companyLogo ? "לחץ להחלפת לוגו" : "לחץ להוספת לוגו") : undefined}
            style={{
              flexShrink: 0, position: "relative",
              cursor: isGuest ? "pointer" : "default",
            }}
          >
            {companyLogo ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={companyLogo}
                alt={companyName}
                style={{ width: 48, height: 48, borderRadius: 8, objectFit: "contain", background: "#fff", border: "1px solid #e5e7eb", opacity: logoUploading ? 0.5 : 1 }}
              />
            ) : (
              <div style={{
                width: 48, height: 48, borderRadius: 8,
                background: isGuest ? "#f3f4f6" : primaryLight,
                border: isGuest ? "1.5px dashed #a78bfa" : "none",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: isGuest ? "20px" : "20px", fontWeight: 800,
                color: isGuest ? "#a78bfa" : primary,
                opacity: logoUploading ? 0.5 : 1,
              }}>
                {isGuest ? (logoUploading ? "⏳" : "🖼") : companyName.charAt(0)}
              </div>
            )}
            {isGuest && !logoUploading && (
              <div style={{
                position: "absolute", bottom: -4, right: -4,
                width: 16, height: 16, borderRadius: "50%",
                background: primary, color: "#fff",
                fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center",
                border: "1.5px solid #fff",
              }}>+</div>
            )}
          </div>
          {/* Hidden image file input */}
          <input
            ref={logoInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleLogoFile}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#111827" }}>{companyName}</div>
            {isGuest && !companyLogo && (
              <div style={{ fontSize: "11px", color: "#a78bfa", marginTop: 2, cursor: "pointer" }} onClick={() => logoInputRef.current?.click()}>
                הוסף לוגו לעסק ←
              </div>
            )}
            {quote.date && (
              <div style={{ fontSize: "11px", color: "#9ca3af", marginTop: 2 }}>
                {new Date(quote.date).toLocaleDateString("he-IL")}
              </div>
            )}
          </div>
        </div>

        {/* Document header */}
        <div style={{ textAlign: "center", marginBottom: 20, paddingBottom: 16, borderBottom: `2px solid ${primary}` }}>
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
                    background: primaryLight,
                    color: primary,
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
              <span style={{ fontSize: "13px", color: primary, fontWeight: 600 }}>סה&quot;כ לתשלום</span>
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
                  style={{ fontSize: "18px", fontWeight: 800, width: 110, textAlign: "right", border: `1px solid ${accent}`, borderRadius: 4, padding: "2px 6px", color: primary, outline: "none", fontFamily: "inherit" }}
                />
              ) : (
                <span
                  onClick={() => { setTotalDraft(quote.total && quote.total > 0 ? String(quote.total) : ""); setEditingTotal(true); }}
                  title="לחץ לעריכה"
                  style={{ fontSize: "20px", fontWeight: 800, color: quote.total > 0 ? primary : accent, cursor: "pointer" }}
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

        const guestNeedsTerms = isGuest && canApprove && !termsAccepted;
        const buttonDisabled  = isBusy || (isGuest && canApprove && !termsAccepted);

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
            {/* Terms checkbox — guests only, shown when button becomes active */}
            {isGuest && canApprove && (
              <label style={{
                display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer",
                fontSize: "12px", color: "#4b5563", lineHeight: 1.5, direction: "rtl",
                marginBottom: 4, width: "100%",
              }}>
                <input
                  type="checkbox"
                  checked={termsAccepted ?? false}
                  onChange={(e) => onTermsChange?.(e.target.checked)}
                  style={{ marginTop: 2, accentColor: primary, flexShrink: 0, width: 15, height: 15, cursor: "pointer" }}
                />
                <span>
                  מאשר/ת את{" "}
                  <a
                    href="https://tik-tok.co.il/terms-privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    style={{ color: primary, textDecoration: "underline" }}
                  >
                    תנאי השימוש ומדיניות הפרטיות
                  </a>
                </span>
              </label>
            )}
            <button
              onClick={() => {
                if (isBusy || guestNeedsTerms) return;
                if (canApprove) onApprove();
                else onBackToChat?.();
              }}
              disabled={buttonDisabled}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "15px 36px",
                borderRadius: 50,
                border: "none",
                background: approveState === "error"
                  ? "linear-gradient(135deg, #ef4444, #dc2626)"
                  : `linear-gradient(135deg, ${primary} 0%, ${accent} 100%)`,
                color: "#fff",
                fontSize: "17px",
                fontWeight: 700,
                cursor: !buttonDisabled ? "pointer" : "default",
                boxShadow: canApprove && !guestNeedsTerms ? `0 4px 24px rgba(124,58,237,0.45)` : "none",
                opacity: (!canApprove || guestNeedsTerms) && approveState === "idle" ? 0.4 : 1,
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
  border: "1px solid #e0e0e0",
  background: "#ffffff",
  color: "#6d28d9",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 0.2s",
};
