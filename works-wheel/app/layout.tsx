import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Works Wheel",
  description: "Interactive 3D portfolio wheel",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}