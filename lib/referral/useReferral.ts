"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, WalletClient } from "viem";
import { REFERRAL_PARAM } from "@/lib/config/referral";
import { normalizeCode } from "@/lib/domain/referralCode";
import { ensureSession, hasSession } from "@/lib/referral/session";

/**
 * Client-side referral state.
 *
 * Responsibilities, deliberately narrow:
 *   - capture `?ref=` from a landing URL and persist it locally until a wallet
 *     is connected (so attribution survives a page reload and the connect step);
 *   - record a click once;
 *   - attribute the signed-in wallet exactly once;
 *   - expose the caller's own dashboard (code + counts).
 *
 * It never decides a referral is "qualified" — that is a server-side decision
 * from on-chain evidence. It never blocks or alters the payment flow: every
 * failure is non-fatal and the composer keeps working.
 */

const STORAGE_KEY = "intent-pay.ref";

export type ReferralCounts = {
  clicks: number;
  attributed: number;
  qualified: number;
  pending: number;
  rejected: number;
};

export type ReferralDashboard = {
  code: string;
  url: string;
  counts: ReferralCounts;
  referrals: Array<{
    id: string;
    referred: string | null;
    state: string;
    attributedAt: number | null;
    qualifiedAt: number | null;
    reason: string | null;
  }>;
};

/** Read a stored pending referral code (validated). */
export function readStoredCode(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeCode(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function storeCode(code: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

function clearStoredCode(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Capture `?ref=` from the URL into local storage. Idempotent: a valid stored
 * code is never overwritten by a later (possibly different) link, so the
 * first-touch referrer is preserved.
 */
export function captureReferralFromUrl(search: string): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(search);
  const incoming = normalizeCode(params.get(REFERRAL_PARAM));
  if (!incoming) return readStoredCode();
  const existing = readStoredCode();
  if (existing) return existing;
  storeCode(incoming);
  // Fire-and-forget click record; never blocks the UI.
  void fetch("/api/referral/click", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: incoming }),
  }).catch(() => undefined);
  return incoming;
}

export function useReferral(wallet: { address?: Address; walletClient?: WalletClient }) {
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<ReferralDashboard | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attributedRef = useRef<string | null>(null);

  // Capture the ref on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const code = captureReferralFromUrl(window.location.search);
    setPendingCode(code);
  }, []);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/referral/me", { cache: "no-store" });
      const json = await res.json();
      if (res.status === 401) {
        setDashboard(null);
        setAuthenticated(false);
        return;
      }
      if (!res.ok || !json.ok) throw new Error(json?.message ?? "Could not load referrals.");
      setDashboard({
        code: json.code,
        url: json.url,
        counts: json.counts,
        referrals: json.referrals,
      });
      setAuthenticated(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // When a wallet connects: establish a session, then attribute once.
  useEffect(() => {
    const address = wallet.address;
    if (!address) {
      setAuthenticated(false);
      setDashboard(null);
      attributedRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      const client = wallet.walletClient;
      if (client && !(await hasSession(address))) {
        const ok = await ensureSession(address, client);
        if (!ok || cancelled) return;
      }
      if (cancelled) return;
      setAuthenticated(true);
      await loadDashboard();
      if (cancelled) return;
      const code = readStoredCode();
      if (code && attributedRef.current !== code) {
        attributedRef.current = code;
        try {
          const res = await fetch("/api/referral/attribute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          });
          const json = await res.json();
          if (json?.ok) {
            clearStoredCode();
            setPendingCode(null);
            await loadDashboard();
          }
        } catch {
          /* non-fatal: the code stays stored and can be retried */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.address, wallet.walletClient, loadDashboard]);

  /** Share the referral link, preferring the native share sheet. */
  const share = useCallback(async (): Promise<"shared" | "copied" | "unavailable"> => {
    if (!dashboard?.url) return "unavailable";
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: "Intent Pay", text: "Pay anyone on Monad in one step.", url: dashboard.url });
        return "shared";
      }
    } catch {
      // User cancelled or share unsupported — fall back to copy.
    }
    try {
      await navigator.clipboard.writeText(dashboard.url);
      return "copied";
    } catch {
      return "unavailable";
    }
  }, [dashboard]);

  const copyLink = useCallback(async (): Promise<boolean> => {
    if (!dashboard?.url) return false;
    try {
      await navigator.clipboard.writeText(dashboard.url);
      return true;
    } catch {
      return false;
    }
  }, [dashboard]);

  return {
    pendingCode,
    dashboard,
    authenticated,
    loading,
    error,
    refresh: loadDashboard,
    share,
    copyLink,
  };
}
