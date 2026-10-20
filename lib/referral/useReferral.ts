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
 *
 * Signing: connecting a wallet does NOT request a signature. A free,
 * human-readable message is signed only when the user explicitly asks for
 * referral access (`authenticate`, driven by the ReferralPanel button). An
 * already-valid session is adopted silently.
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
  const [durable, setDurable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attributedRef = useRef<string | null>(null);

  // Capture the ref on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const code = captureReferralFromUrl(window.location.search);
    setPendingCode(code);
  }, []);

  // Probe durable-storage availability on mount so the UI can explain that
  // referrals are unavailable BEFORE asking for a signature. Non-fatal.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    void fetch("/api/referral/availability", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) setDurable(json?.durable === true);
      })
      .catch(() => {
        /* leave durability unknown; the authenticated call is the authority */
      });
    return () => {
      cancelled = true;
    };
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
      setDurable(json.durable === true);
      setAuthenticated(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // When a wallet connects: adopt an EXISTING session and attribute once. This
  // deliberately does not prompt for a signature — connecting a wallet must not
  // raise a signature request the user did not ask for. The signature is only
  // requested when the user explicitly opens referral functionality
  // (`ensureSession` from the ReferralPanel button or `authenticate` below).
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
      const session = await hasSession(address);
      if (cancelled) return;
      if (!session) {
        // No session yet — do NOT sign. Referral sign-in is user-initiated.
        setAuthenticated(false);
        return;
      }
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

  /**
   * Explicitly authenticate for referral access: sign a free, human-readable
   * message (no gas, no transaction), then load the dashboard and apply any
   * pending attribution. Called only from a user action — never on connect.
   */
  const authenticate = useCallback(async (): Promise<boolean> => {
    const address = wallet.address;
    const client = wallet.walletClient;
    if (!address || !client) return false;
    setLoading(true);
    setError(null);
    try {
      const ok = await ensureSession(address, client);
      if (!ok) return false;
      setAuthenticated(true);
      await loadDashboard();
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
          /* non-fatal */
        }
      }
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
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
    durable,
    loading,
    error,
    refresh: loadDashboard,
    authenticate,
    share,
    copyLink,
  };
}
