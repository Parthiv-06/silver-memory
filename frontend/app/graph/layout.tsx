import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

// Inline so the page needs no /favicon.ico (the app has none, and browsers log the 404).
const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#111113"/>' +
      '<path d="M9 22 16 10l7 12z" fill="none" stroke="#9d8cff" stroke-width="2" stroke-opacity=".55"/>' +
      '<circle cx="16" cy="10" r="4" fill="#b4a2ff"/><circle cx="9" cy="22" r="3" fill="#6cb6ff"/><circle cx="23" cy="22" r="3" fill="#f0a35e"/></svg>',
  );

export const metadata: Metadata = {
  title: "Graph view · Working Volumes",
  description: "An interactive map of notes and the links between them.",
  icons: { icon: ICON },
};

export const viewport: Viewport = {
  themeColor: "#111113",
  colorScheme: "dark",
};

export default function GraphLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className={`${geist.variable} ${geistMono.variable}`}>{children}</div>;
}
