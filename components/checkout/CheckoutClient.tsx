"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/lib/hooks/useWallet";
import { NETWORKS, explorerTxUrl } from "@/lib/config/chains";
import { shortAddress } from "@/lib/format";
import { Copy, ExternalLink, Shield, Spinner, Warning } from "@/components/ui/Icons";
import { ConnectButton } from "@/components/wallet/WalletBar";

/**
 * The customer's payment page.
 *
 * This is the *only* client a customer ever loads, and it holds no credential:
 * it reads and mutates its order through the token-authenticated
 * `/api/checkout/:token` endpoints, and it signs with the customer's own wallet.
 * The merchant's API key is never present.
 *
 * The honesty rule is enforced here too: the page only shows "Payment
 * complete" when the server's independent verification returns `verified`. A
 * broadcast transaction shows "Confirming", never "paid".
 */

type Phase =
  | "awaiting_payment"
  | "awaiting_wallet"
  | "transaction_submitted"
  | "transaction_confirmed"
  | "payment_verified"
  | "payment_failed"
  | "expired"
  | "canceled";

type CheckoutView = {
  id: string;
  object: "checkout";
  status: string;
  phase: Phase;
  orderReference: string | null;
  chainId: number;
  recipient: string;
  receiveToken: string;
  receiveTokenAddress: string;
  amountMode: "recipient_receives" | "i_spend";
  amount: string;
  payToken: string | null;
  expiresAt: string;
  createdAt: string;
  attribution?: { mode: "checkout_bound" | "shared_recipient"; destination: string | null; derivationIndex: number | null };
};

type PreparedCalls = {
  calls: { to: string; data: string; value: string }[];
  quote: {
    payToken: string;
    payAmount: string;
    receiveToken: string;
    receiveAmount: string;
    minimumReceived: string;
    slippageBps: number;
    networkCostUsd: number | null;
  };
};

const POLL_MS = 6000;

function centsOf(usd: string): string {
  return `$${Number(usd).toFixed(2)}`;
}

export function CheckoutClient({ token }: { token: string }) {
  const wallet = useWallet();
  const [view, setView] = useState<CheckoutView | null>(null);
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const preparedRef = useRef<PreparedCalls | null>(null);

  const onMonad = wallet.chainId === NETWORKS.mainnet.chainId;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/checkout/${token}`, { cache: "no-store" });
      if (res.status === 404) {
        setLoadError("This payment link is not valid. Ask the merchant for a new one.");
        return;
      }
      if (!res.ok) {
        setLoadError("We could not load this payment right now. Please try again.");
        return;
      }
      const json = await res.json();
      setView(json.checkout);
      setTxHashes(Array.isArray(json.txHashes) ? json.txHashes : []);
      setLoadError(null);
    } catch {
      setLoadError("We could not reach Intent Pay. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while a payment is in flight so the page reflects confirmation without
  // the customer reloading. Never poll a terminal state.
  useEffect(() => {
    if (!view) return;
    const phase = view.phase;
    const active = phase === "awaiting_payment" || phase === "transaction_submitted" || phase === "transaction_confirmed";
    if (!active) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [view, load]);

  const amountLabel = useMemo(() => {
    if (!view) return "";
    return `${centsOf(view.amount)} in ${view.receiveToken}`;
  }, [view]);

  /** Prepare → sign → submit → verify, in one customer action. */
  const pay = useCallback(async () => {
    if (!wallet.address) return;
    setBusy(true);
    setActionError(null);
    try {
      // 1. Ask the server for the calls, built from the frozen parameters.
      const prep = await fetch(`/api/checkout/${token}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: wallet.address }),
      });
      if (!prep.ok) {
        const err = await prep.json().catch(() => null);
        setActionError(err?.error?.message ?? "This payment could not be prepared. Try again.");
        return;
      }
      const prepared = (await prep.json()) as PreparedCalls;
      preparedRef.current = prepared;

      // 2. The customer's own wallet signs and broadcasts. The page never sees a key.
      if (!wallet.provider) {
        setActionError("Connect a wallet to pay.");
        return;
      }
      const hashes: string[] = [];
      for (const call of prepared.calls) {
        const hash = (await wallet.provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: wallet.address,
              to: call.to,
              data: call.data && call.data !== "0x" ? call.data : undefined,
              value: call.value && call.value !== "0" ? `0x${BigInt(call.value).toString(16)}` : undefined,
            },
          ],
        })) as string;
        if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
          setActionError("Your wallet did not return a transaction hash.");
          return;
        }
        hashes.push(hash);
      }

      // 3. Record the broadcast so the order reflects it.
      const sub = await fetch(`/api/checkout/${token}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHashes: hashes }),
      });
      if (!sub.ok) {
        const err = await sub.json().catch(() => null);
        setActionError(err?.error?.message ?? "Your transaction was sent, but we could not record it. Keep the hash and contact the merchant.");
        setTxHashes(hashes);
        return;
      }
      setTxHashes(hashes);

      // 4. Verify independently. Only `verified` completes the order.
      const ver = await fetch(`/api/checkout/${token}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!ver.ok) {
        const body = (await ver.json().catch(() => null)) as { error?: { message?: string } } | null;
        // A non-OK verify (e.g. replay_detected) is not a completed payment — say so.
        setActionError(body?.error?.message ?? "Your payment could not be verified. Contact the merchant.");
      }
      await load();
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 4001) setActionError("You declined the transaction in your wallet.");
      else setActionError("The transaction could not be completed. You can try again.");
    } finally {
      setBusy(false);
    }
  }, [wallet.address, wallet.provider, token, load]);

  /** Re-check settlement for a submitted payment (an explicit, safe retry). */
  const checkStatus = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await fetch(`/api/checkout/${token}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      await load();
    } finally {
      setBusy(false);
    }
  }, [token, load]);

  if (loading) {
    return (
      <div className="card flex items-center gap-3 p-6 text-sm text-white/60">
        <Spinner className="h-4 w-4" /> Loading your payment…
      </div>
    );
  }

  if (loadError || !view) {
    return (
      <div className="card p-6">
        <div className="flex items-center gap-2 text-amber-200/90">
          <Warning className="h-4 w-4" />
          <p className="text-sm">{loadError ?? "This payment is unavailable."}</p>
        </div>
      </div>
    );
  }

  const terminal = view.phase === "payment_verified" || view.phase === "payment_failed" || view.phase === "expired" || view.phase === "canceled";

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-white/[0.06] px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">Pay with Intent Pay</div>
            <div className="mt-0.5 text-lg font-semibold text-white">{amountLabel}</div>
          </div>
          {view.orderReference && (
            <div className="text-right text-xs text-white/45">
              Order
              <div className="font-mono text-white/70">{view.orderReference}</div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4 px-5 py-5">
        <Row label="Recipient">
          <span className="font-mono text-xs text-white/75">{shortAddress(view.recipient, 6)}</span>
        </Row>
        {view.attribution?.mode === "checkout_bound" && (
          <Row label="Destination">
            <span className="text-[11px] text-emerald-200/80">Unique to this order</span>
          </Row>
        )}
        <Row label="You receive">
          <span className="flex items-center gap-2 text-sm text-white/80">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.08] text-[10px] font-bold text-white/80">
              {view.receiveToken.slice(0, 1)}
            </span>
            {view.receiveToken}
          </span>
        </Row>
        <Row label="Network">
          <span className="text-sm text-white/80">Monad Mainnet · 143</span>
        </Row>

        <PhaseBanner phase={view.phase} onMonad={onMonad} />

        {txHashes.length > 0 && (
          <div className="rounded-xl bg-white/[0.03] p-3">
            <div className="text-[10px] uppercase tracking-wide text-white/40">Transaction</div>
            {txHashes.map((h) => (
              <a
                key={h}
                href={explorerTxUrl("mainnet", h)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 flex items-center gap-1.5 font-mono text-xs text-mono-soft hover:underline"
              >
                {shortAddress(h, 10)} <ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        )}

        {actionError && (
          <div className="flex items-start gap-2 rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-200/90">
            <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{actionError}</span>
          </div>
        )}

        {!terminal && (
          <div className="pt-1">
            {!wallet.address ? (
              <ConnectButton />
            ) : !onMonad ? (
              <button
                onClick={() => void wallet.ensureMonad()}
                className="w-full rounded-xl bg-amber-400/15 px-4 py-3 text-sm font-semibold text-amber-200 transition hover:bg-amber-400/25"
              >
                Switch to Monad Mainnet
              </button>
            ) : (
              <button
                onClick={() => void pay()}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-mono to-mono-deep px-4 py-3 text-sm font-semibold text-white shadow-glow transition disabled:opacity-60"
              >
                {busy ? <Spinner className="h-4 w-4" /> : null}
                {busy ? "Waiting for your wallet…" : `Pay ${centsOf(view.amount)}`}
              </button>
            )}
            {view.phase === "transaction_submitted" && (
              <button
                onClick={() => void checkStatus()}
                disabled={busy}
                className="mt-2 w-full rounded-xl border border-white/10 px-4 py-2.5 text-xs font-medium text-white/70 transition hover:bg-white/[0.04] disabled:opacity-60"
              >
                Check payment status
              </button>
            )}
          </div>
        )}

        {terminal && view.phase === "payment_verified" && (
          <div className="flex items-center gap-2 rounded-xl bg-emerald-400/10 px-3 py-2.5 text-sm text-emerald-200">
            <Shield className="h-4 w-4" /> Payment complete — verified on-chain.
          </div>
        )}

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-white/35">
          <Shield className="mt-0.5 h-3 w-3 shrink-0" />
          You sign in your own wallet. Intent Pay never sees your key, and the amount, asset and
          recipient are fixed by the merchant before you pay.
        </p>

        <button
          onClick={() => {
            void navigator.clipboard?.writeText(window.location.href);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white/70"
        >
          <Copy className="h-3 w-3" /> {copied ? "Link copied" : "Copy payment link"}
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-white/45">{label}</span>
      {children}
    </div>
  );
}

function PhaseBanner({ phase, onMonad }: { phase: Phase; onMonad: boolean }) {
  const map: Record<Phase, { tone: string; text: string }> = {
    awaiting_payment: { tone: "text-white/60", text: onMonad ? "Ready to pay" : "Connect a wallet to pay" },
    awaiting_wallet: { tone: "text-white/60", text: "Waiting for your wallet" },
    transaction_submitted: { tone: "text-sky-200/90", text: "Transaction submitted — confirming on-chain" },
    transaction_confirmed: { tone: "text-sky-200/90", text: "Confirmed on-chain — verifying delivery" },
    payment_verified: { tone: "text-emerald-200", text: "Payment verified" },
    payment_failed: { tone: "text-rose-200", text: "Payment failed" },
    expired: { tone: "text-amber-200/90", text: "This payment link has expired" },
    canceled: { tone: "text-amber-200/90", text: "This payment was canceled by the merchant" },
  };
  const entry = map[phase];
  return <p className={`text-sm ${entry.tone}`}>{entry.text}</p>;
}
