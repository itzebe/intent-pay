import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Intent Pay — Pay with what you have. Send what they need.",
  description:
    "Intent-based payments on Monad. Choose what the recipient should receive; we handle the token conversion and transaction details underneath.",
  applicationName: "Intent Pay",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#08090B",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh">
        <div className="app-bg" aria-hidden />
        <div className="app-grid" aria-hidden />
        {children}
      </body>
    </html>
  );
}
