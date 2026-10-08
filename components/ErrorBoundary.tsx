"use client";

import React from "react";

/**
 * Application-level error boundary.
 *
 * A thrown render error in React 19 unmounts the whole tree, which is exactly
 * the "blank screen" the USDC→MON path produced. This boundary guarantees that
 * any failure inside the payment flow renders a useful, actionable state
 * instead of nothing — while logging a structured diagnostic for development
 * (never a raw stack trace to the user).
 */

export type ErrorBoundaryProps = {
  children: React.ReactNode;
  /** Which part of the app failed — shown to the user and logged. */
  scope: string;
  /** Optional custom fallback; receives a reset callback. */
  fallback?: (info: { error: Error; reset: () => void }) => React.ReactNode;
};

type State = { error: Error | null };

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Structured, secret-free diagnostic for development. No stack or state is
    // shown to the user.
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: "error",
        scope: this.props.scope,
        message: error?.message,
        componentStack: info?.componentStack?.split("\n").slice(0, 6).join(" | "),
      }),
    );
  }

  private reset = () => this.setState({ error: null });

  render(): React.ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback({ error, reset: this.reset });
      return <DefaultFallback scope={this.props.scope} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({ scope, onReset }: { scope: string; onReset: () => void }) {
  return (
    <div className="mx-auto max-w-lg px-5 py-10">
      <div className="card p-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-amber-400/15 text-lg">
          ⚠
        </div>
        <h2 className="text-base font-semibold text-white">Unable to prepare this payment</h2>
        <p className="mt-1.5 text-sm text-white/50">
          Something went wrong while working on this payment. Nothing was signed or sent.
        </p>
        <p className="mt-1 text-[11px] text-white/30">Failure stage: {scope}</p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button onClick={onReset} className="btn-primary px-4">
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded-xl border border-white/[0.12] px-4 py-2 text-sm text-white/70 transition hover:border-white/25"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
