import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Intent Pay — Review the route. Send on Monad.",
  description:
    "Intent-based payments on Monad. Tell Intent Pay what you want to pay, review the route, and confirm your payment from one simple interface.",
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
