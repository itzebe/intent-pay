"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, Spinner, Warning } from "@/components/ui/Icons";

/**
 * Exchanges the emailed verification token for the first API key.
 *
 * The token is read from the URL fragment-free query string and POSTed once. A
 * `useRef` guard makes the exchange idempotent under React's development
 * double-invoke, so a single-use token is never consumed twice by a re-render.
 * The returned key is displayed once and never persisted here.
 */
export function VerifyClient() {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  const run = useCallback(async (token: string) => {
    setState("working");
    setMessage(null);
    try {
      const res = await fetch("/api/v1/developers/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = body.error as { message?: string } | undefined;
        setMessage(err?.message ?? "This verification link could not be used.");
        setState("error");
        return;
      }
      setApiKey(body.apiKey as string);
      const dev = body.developer as { email?: string } | undefined;
      setEmail(dev?.email ?? null);
      setState("done");
    } catch {
      setMessage("The verification service could not be reached.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    if (!token) {
      setMessage("This page needs a verification link. Open the link from your email.");
      setState("error");
      return;
    }
    void run(token);
  }, [run]);

  const copy = useCallback(async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, [apiKey]);

  if (state === "working" || state === "idle") {
    return (
      <div className="card-flat flex items-center gap-3 p-6 text-sm text-white/60">
        <Spinner className="h-4 w-4" />
        Verifying your email…
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="card-flat space-y-4 p-6">
        <div className="flex items-center gap-2 text-red-200">
          <Warning className="h-4 w-4" />
          <span className="text-sm font-semibold">Could not verify</span>
        </div>
        <p className="text-sm leading-relaxed text-white/55">{message}</p>
        <p className="text-xs text-white/40">
          Links expire after 24 hours and can be used once. You can request a new one from the{" "}
          <Link href="/developer" className="text-mono-soft hover:underline">
            developer portal
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="card-flat space-y-4 p-6">
      <div className="flex items-center gap-2 text-emerald-200">
        <Check className="h-4 w-4" />
        <span className="text-sm font-semibold">Email verified</span>
      </div>
      {email && <p className="text-xs text-white/50">{email}</p>}
      <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.04] p-4">
        <div className="flex items-center gap-2 text-amber-200">
          <Warning className="h-4 w-4" />
          <span className="text-xs font-semibold">Your API key — shown once</span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-lg bg-black/40 px-3 py-2 font-mono text-xs text-white/80">
            {apiKey}
          </code>
          <button onClick={copy} className="btn-ghost !px-3 !py-2" type="button">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-white/50">
          Store this key securely. It cannot be retrieved again.
        </p>
      </div>
      <Link href="/developer" className="btn-primary inline-flex !py-2.5 text-sm">
        Go to the portal
      </Link>
    </div>
  );
}
