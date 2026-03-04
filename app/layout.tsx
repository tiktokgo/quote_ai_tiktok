import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "עוזר הצעות מחיר",
  description: "מערכת AI ליצירת הצעות מחיר מקצועיות",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl">
      <body className="antialiased">{children}</body>
    </html>
  );
}
