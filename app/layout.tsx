import type { Metadata } from "next";
// Rubik is self-hosted (@fontsource): next/font/google broke the Vercel build on 25/11/2026
// when Google started answering the build servers with a new font URL format.
import "@fontsource/rubik/hebrew-300.css";
import "@fontsource/rubik/hebrew-400.css";
import "@fontsource/rubik/hebrew-500.css";
import "@fontsource/rubik/hebrew-600.css";
import "@fontsource/rubik/hebrew-700.css";
import "@fontsource/rubik/latin-300.css";
import "@fontsource/rubik/latin-400.css";
import "@fontsource/rubik/latin-500.css";
import "@fontsource/rubik/latin-600.css";
import "@fontsource/rubik/latin-700.css";
import "./globals.css";
import { ThemeProvider } from "@/contexts/ThemeContext";

export const metadata: Metadata = {
  title: "עוזר הצעות מחיר",
  description: "מערכת AI ליצירת הצעות מחיר מקצועיות",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // body uses font-family 'Rubik' (globals.css)
  return (
    <html lang="he" dir="rtl">
      <body className="antialiased"><ThemeProvider>{children}</ThemeProvider></body>
    </html>
  );
}
