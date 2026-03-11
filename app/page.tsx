export default function Home() {
  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(180deg, var(--bg-base) 0%, var(--bg-mid) 50%, var(--bg-end) 100%)",
        color: "var(--text-primary)",
        padding: "24px",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <div style={{ fontSize: "48px", marginBottom: "16px" }}>📋</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, color: "var(--text-heading)", marginBottom: "12px" }}>
          עוזר הצעות מחיר AI
        </h1>
        <p style={{ fontSize: "15px", color: `rgba(var(--purple-light-rgb), 0.7)`, lineHeight: 1.7, marginBottom: "24px" }}>
          פתח דף זה מתוך אפליקציית Bubble עם טוקן תקין.
        </p>
        <div style={{
          padding: "16px 20px",
          background: `rgba(var(--white-overlay-rgb), 0.04)`,
          border: `1px solid rgba(var(--purple-rgb), 0.2)`,
          borderRadius: "12px",
          fontSize: "13px",
          color: `rgba(var(--purple-light-rgb), 0.6)`,
          textAlign: "right",
        }}>
          <strong style={{ color: "var(--text-secondary)" }}>כתובת:</strong> /chat?token=YOUR_JWT_TOKEN
        </div>
      </div>
    </div>
  );
}
