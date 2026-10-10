"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for an error thrown in the root layout itself. Next.js
 * requires this file to render its own <html> and <body>. It shows a minimal,
 * styled recovery page rather than a blank screen.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Structured, secret-free diagnostic. No stack is shown to the user.
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({ level: "error", scope: "global", message: error?.message, digest: error?.digest }),
    );
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#08090b",
          color: "#fff",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <div
            style={{
              width: 44,
              height: 44,
              margin: "0 auto 14px",
              borderRadius: 999,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(251,191,36,0.15)",
              fontSize: 20,
            }}
          >
            ⚠
          </div>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
            Intent Pay couldn&apos;t load
          </h1>
          <p style={{ marginTop: 8, fontSize: 14, lineHeight: 1.5, color: "rgba(255,255,255,0.55)" }}>
            Something went wrong while starting the app. No transaction was prepared or signed.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: 20,
              padding: "10px 18px",
              borderRadius: 14,
              border: "none",
              cursor: "pointer",
              fontWeight: 600,
              color: "#fff",
              backgroundImage: "linear-gradient(180deg, #927ffb, #6f5aef)",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
