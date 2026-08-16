import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Grapplin — Snag any link. Recall with a whisper.",
  description:
    "A private hybrid search engine for everything you save across the internet. Ingest URLs, auto-sync GitHub stars, and search with exact keywords or vague thoughts.",
  icons: {
    icon: "/grapplin-logo.png",
    apple: "/grapplin-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
