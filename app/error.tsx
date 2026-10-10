"use client";

import { useEffect } from "react";

/**
 * Route-segment error boundary. Catches a render error in any page (including
 * the docs pages) so a single bad subtree shows a styled, actionable recovery
 * state instead of a blank page. The app-level and composer-level boundaries in
 * `components/ErrorBoundary.tsx` cover the payment flow specifically.
 */
export default function RouteError({
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
      JSON.stringify({
        level: "error",
        scope: "route",
        message: error?.message,
        digest: error?.digest,
      }),
    );
  }, [error]);

  return (
    <div className="mx-auto max-w-lg px-5 py-16">
      <div className="card p-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-amber-400/15 text-lg">
          ⚠
        </div>
        <h2 className="text-base font-semibold text-white">Something went wrong</h2>
        <p className="mt-1.5 text-sm text-white/50">
          This page could not be displayed. No transaction was prepared or signed.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button onClick={reset} className="btn-primary px-4">
            Try again
          </button>
          <button
            onClick={() => window.location.assign("/")}
            className="rounded-xl border border-white/[0.12] px-4 py-2 text-sm text-white/70 transition hover:border-white/25"
          >
            Back to payments
          </button>
        </div>
      </div>
    </div>
  );
}
