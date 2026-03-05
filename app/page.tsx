export default function Home() {
  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(180deg, #07071a 0%, #0b0920 50%, #0f0c28 100%)",
        color: "#e2e8f0",
        padding: "24px",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <div style={{ fontSize: "48px", marginBottom: "16px" }}>📋</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, color: "#e9d5ff", marginBottom: "12px" }}>
          עוזר הצעות מחיר AI
        </h1>
        <p style={{ fontSize: "15px", color: "rgba(196,181,253,0.7)", lineHeight: 1.7, marginBottom: "24px" }}>
          פתח דף זה מתוך אפליקציית Bubble עם טוקן תקין.
        </p>
        <div style={{
          padding: "16px 20px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(139,92,246,0.2)",
          borderRadius: "12px",
          fontSize: "13px",
          color: "rgba(196,181,253,0.6)",
          textAlign: "right",
        }}>
          <strong style={{ color: "#c4b5fd" }}>כתובת:</strong> /chat?token=YOUR_JWT_TOKEN
        </div>
      </div>
    </div>
  );
}
