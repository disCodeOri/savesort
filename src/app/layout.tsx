import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "SaveSort — Find what you saved",
  description:
    "A private search engine for useful things you save across the internet.",
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
