"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBalances, useWallet } from "@/lib/hooks/useWallet";
import { getClientPublicClient } from "@/lib/wallet/clients";
import { sendCallsSequentially } from "@/lib/wallet/sendCalls";
import { prepareTxFields, buildSendParams } from "@/lib/execution/prepareTx";
import { logCheckoutDiagnostic, diagnosticCodeOf } from "@/lib/wallet/checkoutDiagnostics";
import { classifyTransactionError, isTransportError } from "@/lib/domain/transactionError";
import { recoverWithAppRpc } from "@/lib/execution/recoveryClient";
import { SUBMISSION_UNKNOWN_MESSAGE, type AttemptIdentity } from "@/lib/domain/recovery";
import { NETWORKS, explorerTxUrl } from "@/lib/config/chains";
import { shortAddress } from "@/lib/format";
import { Copy, ExternalLink, Shield, Spinner, Warning } from "@/components/ui/Icons";
import { BalanceOverview, ConnectButton } from "@/components/wallet/WalletBar";

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

/**
 * The phase a renderer may actually receive. The server is the source of truth
 * and a newer deployment can return a phase this bundle does not know, so the
 * UI must treat the value as untrusted: an unrecognised phase renders a neutral
 * state instead of throwing (which unmounted the tree and blanked the page).
 */
type RenderPhase = Phase | (string & {});

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

/**
 * Validate the server-supplied checkout before anything renders it.
 *
 * The server is the source of truth and a newer deployment can return a shape
 * this bundle does not expect. The render path reads `receiveToken`, `recipient`
 * and `amount` directly, so a missing or mistyped field used to throw inside
 * render (`receiveToken.slice`) and blank the whole page. Validating here turns
 * any such payload into the honest "payment unavailable" state instead — the
 * page stays usable and never unmounts.
 */
function parseCheckoutView(value: unknown): CheckoutView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);

  const id = str(v.id);
  const receiveToken = str(v.receiveToken);
  const recipient = str(v.recipient);
  const amount = str(v.amount);
  if (!id || !receiveToken || !recipient || !amount) return null;
  // The amount is rendered through `Number(...).toFixed(2)`; a non-numeric
  // value would otherwise show "$NaN".
  if (!Number.isFinite(Number(amount))) return null;

  const attribution =
    v.attribution && typeof v.attribution === "object" && !Array.isArray(v.attribution)
      ? (v.attribution as CheckoutView["attribution"])
      : undefined;

  return {
    id,
    object: "checkout",
    status: str(v.status) ?? "open",
    phase: (str(v.phase) ?? "awaiting_payment") as Phase,
    orderReference: str(v.orderReference),
    chainId: typeof v.chainId === "number" ? v.chainId : NETWORKS.mainnet.chainId,
    recipient,
    receiveToken,
    receiveTokenAddress: str(v.receiveTokenAddress) ?? "",
    amountMode: v.amountMode === "i_spend" ? "i_spend" : "recipient_receives",
    amount,
    payToken: str(v.payToken),
    expiresAt: str(v.expiresAt) ?? "",
    createdAt: str(v.createdAt) ?? "",
    attribution,
  };
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
  // Set when the wallet authorised but then failed on its own transport, so the
  // outcome is unknown. Pay is disabled until a status check proves nothing was
  // broadcast — otherwise a retry could double-pay.
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [statusChecked, setStatusChecked] = useState(false);
  // The exact first call we asked the wallet to send, so a status check can match
  // a candidate found on chain. Set from the prepared calls just before signing.
  const attemptIdentityRef = useRef<AttemptIdentity | null>(null);
  // The account's pending nonce just before the attempt — a recovery CLUE only,
  // never proof (an unrelated tx advances it; a node's mempool view is local).
  const baselineNonceRef = useRef<bigint | undefined>(undefined);
  const preparedRef = useRef<PreparedCalls | null>(null);

  const onMonad = wallet.chainId === NETWORKS.mainnet.chainId;

  // The customer's real holdings, so they can see what they have before paying.
  // Read only for a connected wallet on the right network; balances are then
  // *unknown*, never a false zero.
  const { balances, loading: balancesLoading } = useBalances(
    wallet.address,
    wallet.network ?? "mainnet",
    Boolean(wallet.address) && onMonad,
  );

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
      const parsed = parseCheckoutView(json?.checkout);
      if (!parsed) {
        setLoadError("This payment link could not be read. Ask the merchant for a new one.");
        return;
      }
      setView(parsed);
      setTxHashes(
        Array.isArray(json?.txHashes) ? json.txHashes.filter((h: unknown) => typeof h === "string") : [],
      );
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
    setUnknownOutcome(false);
    setStatusNote(null);
    setStatusChecked(false);
    const kind: "injected" | "walletconnect" | "none" = wallet.kind ?? (wallet.provider ? "injected" : "none");
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
        logCheckoutDiagnostic({ stage: "prepare", walletKind: kind, chainId: wallet.chainId, code: err?.error?.code });
        return;
      }
      const prepared = (await prep.json()) as PreparedCalls;
      // A malformed prepare response must be a clear error, never a crash on
      // `prepared.calls.length` (which would blank the page).
      if (!prepared || !Array.isArray(prepared.calls) || prepared.calls.length === 0) {
        setActionError("This payment could not be prepared. Try again or contact the merchant.");
        logCheckoutDiagnostic({ stage: "prepare", walletKind: kind, chainId: wallet.chainId, code: "malformed_prepare" });
        return;
      }
      preparedRef.current = prepared;

      // Record whatever has actually been broadcast, so an interrupted payment
      // still shows its hash(es) and can be status-checked. Best-effort: a
      // failure here must not hide the transaction the customer already sent.
      const recordSubmitted = async (hs: string[]) => {
        if (hs.length === 0) return;
        setTxHashes(hs);
        try {
          await fetch(`/api/checkout/${token}/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ txHashes: hs }),
          });
        } catch {
          /* the hash is still displayed; recording is best-effort */
        }
        // Reflect the recorded state so the order shows "submitted" and offers a
        // status check rather than appearing unpaid.
        await load();
      };

      // 2. The customer's own wallet signs and broadcasts. The page never sees a
      //    key. A swap payment is several sequential transactions (approve → swap
      //    → unwrap → deliver) and each depends on the previous being mined, so
      //    they are sent and confirmed one at a time (`sendCallsSequentially`).
      if (!wallet.provider) {
        setActionError("Connect a wallet to pay.");
        return;
      }
      const pub = getClientPublicClient(wallet.network ?? "mainnet");
      // Baseline the account's pending nonce before the wallet is asked to sign,
      // so a post-authorisation failure can be probed for real activity. A clue
      // only — never proof of what this payment did.
      try {
        baselineNonceRef.current = BigInt(
          await pub.getTransactionCount({ address: wallet.address as `0x${string}`, blockTag: "pending" }),
        );
      } catch {
        baselineNonceRef.current = undefined;
      }
      // Capture the exact first call we are about to ask the wallet to send, so a
      // later status check can match a candidate on chain field-by-field (the
      // calldata, recipient and value are the app's own frozen values).
      const firstCall = prepared.calls[0];
      attemptIdentityRef.current = {
        from: wallet.address as `0x${string}`,
        to: firstCall?.to as `0x${string}` | undefined,
        value: firstCall?.value && firstCall.value !== "0" ? BigInt(firstCall.value) : undefined,
        data: firstCall?.data && firstCall.data !== "0x" ? (firstCall.data as `0x${string}`) : undefined,
        baselineNonce: baselineNonceRef.current,
      };
      const outcome = await sendCallsSequentially({
        calls: prepared.calls,
        send: async (call) => {
          // Prepare the envelope (gas / EIP-1559 fees / nonce) with Intent Pay's
          // OWN RPC before the wallet sees it, so a wallet whose own node is
          // unreachable (Trust Wallet's in-app browser proxying to
          // `monad.twnodes.com`) has nothing left to estimate. A multi-call
          // payment gets a fresh nonce per call so the sequence cannot reorder.
          const envelope = await prepareTxFields(
            pub,
            {
              to: call.to as `0x${string}`,
              data: call.data && call.data !== "0x" ? (call.data as `0x${string}`) : undefined,
              value: call.value && call.value !== "0" ? BigInt(call.value) : undefined,
            },
            {
              account: wallet.address as `0x${string}`,
              includeNonce: prepared.calls.length > 1,
            },
          );
          return wallet.provider!.request({
            method: "eth_sendTransaction",
            params: [
              buildSendParams({
                from: wallet.address as `0x${string}`,
                to: call.to as `0x${string}`,
                data: call.data && call.data !== "0x" ? (call.data as `0x${string}`) : undefined,
                value: call.value && call.value !== "0" ? BigInt(call.value) : undefined,
                // The chain identity travels with the request, so the wallet
                // never has to answer `eth_chainId` itself. A page-world provider
                // (Trust Wallet) proxies that read to its own node, which is
                // unreachable on Monad — and a wallet-side failure must not be
                // mistaken for Intent Pay's RPC being down.
                chainId: `0x${(wallet.chainId ?? 143).toString(16)}` as `0x${string}`,
                prepared: envelope,
              }),
            ],
          });
        },
        waitForReceipt: (hash) =>
          getClientPublicClient(wallet.network ?? "mainnet").waitForTransactionReceipt({
            hash: hash as `0x${string}`,
            confirmations: 2,
            timeout: 90_000,
          }),
      });

      if (!outcome.ok) {
        // Record whatever already broadcast so the order reflects it, then stop.
        await recordSubmitted(outcome.hashes);
        // A transport failure the *wallet's* provider hit is not our RPC being
        // down: say so plainly. But it is NOT proof nothing was sent — the wallet
        // is asked to send only after the customer authorised, so if it holds no
        // hash we cannot rule out a broadcast. Mark the outcome unknown and
        // require a status check before any retry (which could double-pay).
        const walletTransport = outcome.reason === "send_failed" && isTransportError(outcome.cause);
        setActionError(
          walletTransport
            ? classifyTransactionError(outcome.cause, { source: "wallet" }).message
            : outcome.message,
        );
        if (walletTransport && outcome.hashes.length === 0) {
          setUnknownOutcome(true);
        }
        logCheckoutDiagnostic({
          stage: outcome.reason === "unconfirmed" ? "receipt" : "broadcast",
          walletKind: kind,
          chainId: wallet.chainId,
          code: walletTransport ? "wallet_rpc" : outcome.reason,
        });
        return;
      }
      const hashes = outcome.hashes;

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
        logCheckoutDiagnostic({ stage: "submit", walletKind: kind, chainId: wallet.chainId, code: err?.error?.code });
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
        const body = (await ver.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
        // A non-OK verify (e.g. replay_detected) is not a completed payment — say so.
        setActionError(body?.error?.message ?? "Your payment could not be verified. Contact the merchant.");
        logCheckoutDiagnostic({ stage: "verify", walletKind: kind, chainId: wallet.chainId, code: body?.error?.code });
      }
      await load();
    } catch (err) {
      // Every failure is recoverable and must leave the checkout visible with a
      // specific message — a thrown value error must never blank the page.
      const info = classifyTransactionError(err);
      setActionError(info.message);
      logCheckoutDiagnostic({ stage: "sign", walletKind: kind, chainId: wallet.chainId, code: diagnosticCodeOf(err) ?? info.kind });
      // Reflect any real state change (the intent may now be submitted/failed).
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [wallet.address, wallet.provider, wallet.network, wallet.chainId, wallet.kind, token, load]);

  /** Re-check settlement for a submitted payment (an explicit, safe retry). */
  const checkStatus = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    setStatusNote(null);
    try {
      // Unknown outcome (the wallet failed on its own transport after the
      // customer authorised): recover the true state from evidence read through
      // Intent Pay's own RPC endpoints. A nonce reading is a clue only — an
      // advanced nonce is reported as un-attributable activity and an unchanged
      // nonce never proves nothing was sent, so Pay stays disabled unless a
      // definite pre-submission failure is established.
      if (unknownOutcome) {
        const identity: AttemptIdentity = attemptIdentityRef.current ?? {
          from: wallet.address as `0x${string}`,
          baselineNonce: baselineNonceRef.current,
        };
        const result = await recoverWithAppRpc({
          network: wallet.network ?? "mainnet",
          attempt: identity,
          hashes: txHashes as `0x${string}`[],
        });
        if (result.outcome.state === "CONFIRMED" || result.outcome.state === "REVERTED") {
          // The chain has spoken; reflect it and re-verify independently.
          setStatusNote(result.message);
          setUnknownOutcome(false);
          if (result.outcome.state === "CONFIRMED") {
            await fetch(`/api/checkout/${token}/verify`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            }).catch(() => undefined);
          }
          await load();
          return;
        }
        if (result.outcome.state === "DEFINITIVE_FAILURE") {
          setStatusNote(result.message);
          setUnknownOutcome(false);
          return;
        }
        // SUBMITTED / SUBMISSION_UNKNOWN: keep Pay disabled and show the honest
        // note. An explorer link is only offered when we hold a real hash.
        if (result.hash && !txHashes.includes(result.hash)) setTxHashes([result.hash]);
        setStatusNote(result.message);
        return;
      }
      await fetch(`/api/checkout/${token}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      await load();
    } finally {
      setStatusChecked(true);
      setBusy(false);
    }
  }, [unknownOutcome, wallet.address, wallet.network, token, load]);

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
            <div className="text-[10px] uppercase tracking-[0.16em] text-white/55">Pay with Intent Pay</div>
            <div className="mt-0.5 text-lg font-semibold text-white">{amountLabel}</div>
          </div>
          {view.orderReference && (
            <div className="text-right text-xs text-white/55">
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
            <div className="text-[10px] uppercase tracking-wide text-white/55">Transaction</div>
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

        {unknownOutcome ? (
          <div className="flex items-start gap-2 rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-200/90">
            <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold text-amber-100">Payment status needs checking</p>
              <p>{statusNote ?? actionError ?? SUBMISSION_UNKNOWN_MESSAGE}</p>
            </div>
          </div>
        ) : (
          actionError && (
            <div className="flex items-start gap-2 rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-200/90">
              <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{actionError}</span>
            </div>
          )
        )}

        {statusNote && !unknownOutcome && (
          <div className="flex items-start gap-2 rounded-xl bg-white/[0.04] px-3 py-2 text-xs text-white/70">
            <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/55" />
            <span>{statusNote}</span>
          </div>
        )}

        {!terminal && wallet.address && onMonad && (
          <BalanceOverview balances={balances} loading={balancesLoading} connected />
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
                disabled={busy || unknownOutcome}
                title={unknownOutcome ? "Check the payment status first — a transaction may already have been sent." : undefined}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-mono to-mono-deep px-4 py-3 text-sm font-semibold text-white shadow-glow transition disabled:opacity-60"
              >
                {busy ? <Spinner className="h-4 w-4" /> : null}
                {busy ? "Waiting for your wallet…" : `Pay ${centsOf(view.amount)}`}
              </button>
            )}
            {(view.phase === "transaction_submitted" || unknownOutcome) && (
              <button
                onClick={() => void checkStatus()}
                disabled={busy}
                className="mt-2 w-full rounded-xl border border-white/10 px-4 py-2.5 text-xs font-medium text-white/70 transition hover:bg-white/[0.04] disabled:opacity-60"
              >
                {statusChecked && unknownOutcome ? "Check payment status again" : "Check payment status"}
              </button>
            )}
          </div>
        )}

        {terminal && view.phase === "payment_verified" && (
          <div className="flex items-center gap-2 rounded-xl bg-emerald-400/10 px-3 py-2.5 text-sm text-emerald-200">
            <Shield className="h-4 w-4" /> Payment complete — verified on-chain.
          </div>
        )}

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-white/55">
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
          className="flex items-center gap-1.5 text-[11px] text-white/55 hover:text-white/70"
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
      <span className="text-xs text-white/55">{label}</span>
      {children}
    </div>
  );
}

function PhaseBanner({ phase, onMonad }: { phase: RenderPhase; onMonad: boolean }) {
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
  // An unrecognised phase (a newer server than this bundle) is reported as
  // "updating" rather than crashing — the page stays usable.
  const entry = map[phase as Phase] ?? {
    tone: "text-white/60",
    text: "Updating your payment status…",
  };
  return <p className={`text-sm ${entry.tone}`}>{entry.text}</p>;
}
