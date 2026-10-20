"use client";

import { useState } from "react";
import type { Address, WalletClient } from "viem";
import { useReferral } from "@/lib/referral/useReferral";
import { ensureSession } from "@/lib/referral/session";
import { shortAddress } from "@/lib/format";
import { Copy, Check, Spinner, ExternalLink } from "@/components/ui/Icons";

/**
 * Referral dashboard.
 *
 * Shows the connected wallet's own referral code, a share link, and honest
 * counts. A click is never shown as a successful referral: the list
 * distinguishes attributed, pending and qualified states, and the copy says so.
 *
 * When the wallet is not signed in, a single explicit action (a free message
 * signature) establishes the session. Nothing here touches the payment flow.
 */
export function ReferralPanel({
  address,
  walletClient,
}: {
  address?: Address;
  walletClient?: WalletClient;
}) {
  const ref = useReferral({ address, walletClient });
  const [copied, setCopied] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  if (!address) return null;

  const copy = async () => {
    const ok = await ref.copyLink();
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const share = async () => {
    const result = await ref.share();
    setShareMsg(
      result === "shared" ? "Shared." : result === "copied" ? "Link copied." : "Sharing isn't available — copy the link instead.",
    );
    setTimeout(() => setShareMsg(null), 2400);
  };

  const signIn = async () => {
    if (!walletClient) return;
    setSigningIn(true);
    try {
      const ok = await ensureSession(address, walletClient);
      if (ok) await ref.refresh();
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <section className="mx-auto mt-6 max-w-5xl px-5">
      <div className="card p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Refer a friend</h3>
            <p className="mt-0.5 text-xs text-white/45">
              Share Intent Pay. Rewards apply only once a referred wallet makes a verified on-chain payment.
            </p>
          </div>
        </div>

        {!ref.authenticated ? (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-white/50">
              Sign a free message to create your referral link. No gas, no transaction.
            </p>
            <button onClick={signIn} disabled={signingIn || !walletClient} className="btn-primary shrink-0">
              {signingIn ? (
                <span className="flex items-center gap-2">
                  <Spinner className="h-3.5 w-3.5 animate-spin" /> Waiting for signature…
                </span>
              ) : (
                "Create my referral link"
              )}
            </button>
          </div>
        ) : ref.dashboard ? (
          <>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex flex-1 items-center gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
                <span className="font-mono text-sm text-white/90">{ref.dashboard.code}</span>
              </div>
              <button onClick={copy} className="btn-ghost shrink-0" aria-label="Copy referral link">
                {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
                <span className="ml-1.5">{copied ? "Copied" : "Copy link"}</span>
              </button>
              <button onClick={share} className="btn-primary shrink-0">
                <ExternalLink className="h-4 w-4" />
                <span className="ml-1.5">Share</span>
              </button>
            </div>
            {shareMsg && <p className="mt-2 text-xs text-white/50">{shareMsg}</p>}

            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Link opens" value={ref.dashboard.counts.clicks} />
              <Stat label="Attributed" value={ref.dashboard.counts.attributed} />
              <Stat label="Qualified" value={ref.dashboard.counts.qualified} />
              <Stat label="Pending" value={ref.dashboard.counts.pending} />
            </dl>

            {ref.dashboard.referrals.length > 0 ? (
              <ul className="mt-4 divide-y divide-white/[0.06]">
                {ref.dashboard.referrals.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                    <span className="font-mono text-white/60">
                      {r.referred ? shortAddress(r.referred, 4) : "—"}
                    </span>
                    <span className={stateClass(r.state)}>{stateLabel(r.state)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-xs text-white/40">
                No referrals yet. Share your link to get started.
              </p>
            )}
          </>
        ) : (
          <p className="mt-4 text-xs text-white/50">
            {ref.loading ? "Loading your referrals…" : ref.error ?? "Referrals are unavailable right now."}
          </p>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="num text-lg font-semibold text-white">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-white/40">{label}</div>
    </div>
  );
}

function stateLabel(state: string): string {
  switch (state) {
    case "qualified":
      return "Qualified";
    case "pending_verification":
      return "Pending verification";
    case "rejected":
      return "Rejected";
    case "registered":
      return "Registered";
    case "activated":
      return "Activated";
    default:
      return "Attributed";
  }
}

function stateClass(state: string): string {
  const base = "rounded-full px-2 py-0.5 text-[10px] font-medium";
  if (state === "qualified") return `${base} bg-emerald-400/10 text-emerald-200/90`;
  if (state === "rejected") return `${base} bg-red-400/10 text-red-200/80`;
  if (state === "pending_verification") return `${base} bg-amber-400/10 text-amber-200/80`;
  return `${base} bg-white/[0.06] text-white/50`;
}
