"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isEvmAddress, shortAddress } from "@/lib/format";
import { useWallet } from "@/lib/hooks/useWallet";
import { Copy, ExternalLink, Spinner, Warning } from "@/components/ui/Icons";
import { PaymentQR } from "@/components/checkout/PaymentQR";

/**
 * The merchant console.
 *
 * A single, self-contained page that lets a business create a checkout link and
 * watch its orders settle. It is a **client** of the versioned `/api/v1` API —
 * the same API an external integrator uses — so it exercises exactly what a real
 * merchant would build, and it cannot drift from the public contract.
 *
 * The API key is held in this browser only (in component state, entered by the
 * operator), never stored server-side and never bundled. Connecting a wallet is
 * separate: the wallet is where the merchant *receives* funds, not how the
 * dashboard authenticates.
 */

type Checkout = {
  id: string;
  status: string;
  phase: string;
  orderReference: string | null;
  token: string;
  amount?: string;
  receiveToken?: string;
  expiresAt: string;
  createdAt: string;
  attribution?: { mode: "checkout_bound" | "shared_recipient"; destination: string | null };
};

type Attribution = {
  mode: "checkout_bound" | "shared_recipient";
  checkoutBound: boolean;
  nextDerivationIndex: number;
  preview: string[];
  note?: string;
};

const STORAGE_KEY = "intentpay.merchant.apiKey";

async function api(key: string, path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export function MerchantConsole() {
  const wallet = useWallet();
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Create form
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("10");
  const [receiveToken, setReceiveToken] = useState("USDC");
  const [orderReference, setOrderReference] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [created, setCreated] = useState<{ id: string; token: string; link: string } | null>(null);
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [copied, setCopied] = useState(false);
  const [attribution, setAttribution] = useState<Attribution | null>(null);
  const [xpubInput, setXpubInput] = useState("");
  const [savingXpub, setSavingXpub] = useState(false);
  const [xpubError, setXpubError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setApiKey(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Prefill the recipient from the connected wallet — the merchant receives there.
  useEffect(() => {
    if (wallet.address && !recipient) setRecipient(wallet.address);
  }, [wallet.address, recipient]);

  const connect = useCallback(async () => {
    setAuthError(null);
    const res = await api(apiKey, "/developers");
    if (!res.ok) {
      setAuthError(res.status === 401 ? "That API key was not accepted." : "Could not reach the API.");
      setConnected(false);
      return;
    }
    setConnected(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, apiKey);
    } catch {
      /* ignore */
    }
    const list = await api(apiKey, "/checkouts");
    if (list.ok) setCheckouts((list.body.checkouts as Checkout[]) ?? []);
    const attr = await api(apiKey, "/attribution");
    if (attr.ok) setAttribution(attr.body.attribution as Attribution);
  }, [apiKey]);

  const refresh = useCallback(async () => {
    if (!connected) return;
    const list = await api(apiKey, "/checkouts");
    if (list.ok) setCheckouts((list.body.checkouts as Checkout[]) ?? []);
  }, [apiKey, connected]);

  const create = useCallback(async () => {
    setFormError(null);
    if (!isEvmAddress(recipient)) {
      setFormError("Enter the Monad address that should receive the payment.");
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setFormError("Enter an amount in USD.");
      return;
    }
    setCreating(true);
    try {
      // 1. Create the intent (the amount, asset and recipient).
      const intent = await api(apiKey, "/intents", {
        method: "POST",
        body: JSON.stringify({
          recipient,
          receiveToken,
          amount,
          amountMode: "recipient_receives",
          ...(orderReference ? { reference: orderReference } : {}),
        }),
      });
      if (!intent.ok) {
        setFormError((intent.body.error as { message?: string })?.message ?? "Could not create the payment.");
        return;
      }
      const intentId = (intent.body.intent as { id: string }).id;

      // 2. Create the checkout (the payable order + its payment link).
      const checkout = await api(apiKey, "/checkouts", {
        method: "POST",
        body: JSON.stringify({ intentId, ...(orderReference ? { orderReference } : {}) }),
      });
      if (!checkout.ok) {
        setFormError((checkout.body.error as { message?: string })?.message ?? "Could not create the checkout.");
        return;
      }
      const token = checkout.body.token as string;
      setCreated({ id: (checkout.body.checkout as { id: string }).id, token, link: `${window.location.origin}/checkout/${token}` });
      await refresh();
    } finally {
      setCreating(false);
    }
  }, [apiKey, recipient, receiveToken, amount, orderReference, refresh]);

  const saveXpub = useCallback(
    async (value: string | null) => {
      setXpubError(null);
      setSavingXpub(true);
      try {
        const res = await api(apiKey, "/attribution", { method: "POST", body: JSON.stringify({ paymentXpub: value }) });
        if (!res.ok) {
          setXpubError((res.body.error as { message?: string })?.message ?? "Could not save the payment xpub.");
          return;
        }
        setAttribution(res.body.attribution as Attribution);
        setXpubInput("");
      } finally {
        setSavingXpub(false);
      }
    },
    [apiKey],
  );

  const cancel = useCallback(
    async (id: string) => {
      await api(apiKey, `/checkouts/${id}/cancel`, { method: "POST" });
      await refresh();
    },
    [apiKey, refresh],
  );

  const statusTone = useMemo(
    () => (status: string) =>
      status === "completed"
        ? "text-emerald-200 bg-emerald-400/10"
        : status === "open"
          ? "text-sky-200 bg-sky-400/10"
          : "text-white/50 bg-white/[0.05]",
    [],
  );

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <h2 className="text-sm font-semibold text-white/90">Connect your merchant account</h2>
        <p className="mt-1 text-xs text-white/45">
          Paste the API key for your Intent Pay developer account. It stays in this browser and is
          never sent anywhere except the API.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="ipk_live_…"
            className="flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 font-mono text-xs text-white placeholder:text-white/25 focus:border-mono/50 focus:outline-none"
          />
          <button
            onClick={() => void connect()}
            disabled={!apiKey}
            className="rounded-xl bg-gradient-to-br from-mono to-mono-deep px-4 py-2.5 text-sm font-semibold text-white shadow-glow transition disabled:opacity-50"
          >
            {connected ? "Connected" : "Connect"}
          </button>
        </div>
        {authError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-200/90">
            <Warning className="h-3.5 w-3.5" /> {authError}
          </p>
        )}
      </section>

      {connected && (
        <>
          <section className="card p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white/90">Payment attribution</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  attribution?.checkoutBound ? "text-emerald-200 bg-emerald-400/10" : "text-amber-200 bg-amber-400/10"
                }`}
              >
                {attribution?.checkoutBound ? "Per-order destination" : "Shared recipient"}
              </span>
            </div>
            <p className="mt-1 text-xs text-white/45">
              {attribution?.checkoutBound
                ? "Each order is paid to a unique address derived from your xpub. Only your wallet holds the keys; Intent Pay watches, and can never spend."
                : "Without a payment xpub, orders share your recipient, so attribution relies on the token, amount and timing guards. Register an xpub to give every order its own destination."}
            </p>
            {attribution?.checkoutBound && attribution.preview.length > 0 && (
              <div className="mt-3 rounded-xl bg-white/[0.03] p-3">
                <div className="text-[10px] uppercase tracking-wide text-white/40">Next destinations</div>
                <div className="mt-1 space-y-0.5 font-mono text-[11px] text-white/60">
                  {attribution.preview.map((a) => (
                    <div key={a} className="truncate">
                      {a}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                value={xpubInput}
                onChange={(e) => setXpubInput(e.target.value)}
                placeholder={attribution?.checkoutBound ? "Replace xpub (xpub…)" : "xpub… (watch-only public key)"}
                className="flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 font-mono text-[11px] text-white placeholder:text-white/25 focus:border-mono/50 focus:outline-none"
              />
              <button
                onClick={() => void saveXpub(xpubInput.trim() || null)}
                disabled={!xpubInput.trim() || savingXpub}
                className="rounded-xl border border-white/10 px-4 py-2.5 text-xs font-semibold text-white/80 transition hover:bg-white/[0.04] disabled:opacity-40"
              >
                {savingXpub ? "Saving…" : attribution?.checkoutBound ? "Replace" : "Enable"}
              </button>
              {attribution?.checkoutBound && (
                <button
                  onClick={() => void saveXpub(null)}
                  disabled={savingXpub}
                  className="rounded-xl border border-white/10 px-3 py-2.5 text-xs text-white/50 transition hover:text-rose-200 disabled:opacity-40"
                >
                  Disable
                </button>
              )}
            </div>
            <p className="mt-2 text-[11px] text-white/35">
              A public extended key only. A private key (xprv) or a seed phrase is refused.
            </p>
            {xpubError && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-200/90">
                <Warning className="h-3.5 w-3.5" /> {xpubError}
              </p>
            )}
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold text-white/90">Create a payment link</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Amount (USD)">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-white focus:border-mono/50 focus:outline-none"
                />
              </Field>
              <Field label="Customer pays in">
                <input
                  value={receiveToken}
                  onChange={(e) => setReceiveToken(e.target.value.toUpperCase())}
                  className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-white focus:border-mono/50 focus:outline-none"
                />
              </Field>
              <Field label="Receive to (Monad address)" full>
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="0x…"
                  className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 font-mono text-xs text-white placeholder:text-white/25 focus:border-mono/50 focus:outline-none"
                />
                {wallet.address && (
                  <button
                    onClick={() => setRecipient(wallet.address!)}
                    className="mt-1 text-[11px] text-mono-soft hover:underline"
                  >
                    Use connected wallet ({shortAddress(wallet.address)})
                  </button>
                )}
              </Field>
              <Field label="Order reference (optional)" full>
                <input
                  value={orderReference}
                  onChange={(e) => setOrderReference(e.target.value)}
                  placeholder="ORDER-1001"
                  className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-mono/50 focus:outline-none"
                />
              </Field>
            </div>
            {formError && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-200/90">
                <Warning className="h-3.5 w-3.5" /> {formError}
              </p>
            )}
            <button
              onClick={() => void create()}
              disabled={creating}
              className="mt-4 flex items-center gap-2 rounded-xl bg-gradient-to-br from-mono to-mono-deep px-4 py-2.5 text-sm font-semibold text-white shadow-glow transition disabled:opacity-60"
            >
              {creating ? <Spinner className="h-4 w-4" /> : null}
              {creating ? "Creating…" : "Create payment link"}
            </button>
          </section>

          {created && (
            <section className="card p-5">
              <h2 className="text-sm font-semibold text-white/90">Share this payment link</h2>
              <div className="mt-3 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                <PaymentQR value={created.link} />
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="rounded-xl bg-white/[0.03] p-3">
                    <div className="text-[10px] uppercase tracking-wide text-white/40">Payment link</div>
                    <div className="mt-1 break-all font-mono text-xs text-white/75">{created.link}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        void navigator.clipboard?.writeText(created.link);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                      className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs font-medium text-white/75 transition hover:bg-white/[0.04]"
                    >
                      <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy link"}
                    </button>
                    <a
                      href={created.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs font-medium text-white/75 transition hover:bg-white/[0.04]"
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> Open checkout
                    </a>
                  </div>
                </div>
              </div>
            </section>
          )}

          <section className="card p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white/90">Orders</h2>
              <button onClick={() => void refresh()} className="text-xs text-mono-soft hover:underline">
                Refresh
              </button>
            </div>
            {checkouts.length === 0 ? (
              <p className="mt-3 text-xs text-white/40">No orders yet.</p>
            ) : (
              <div className="mt-3 divide-y divide-white/[0.05]">
                {checkouts.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-xs text-white/75">
                        {c.orderReference ?? c.id}
                        {c.amount ? <span className="text-white/45"> · ${c.amount}</span> : null}
                      </div>
                      <a
                        href={`/checkout/${c.token}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-mono-soft hover:underline"
                      >
                        /checkout/{c.token.slice(0, 14)}…
                      </a>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(c.status)}`}>{c.status}</span>
                      {c.status === "open" && (
                        <button onClick={() => void cancel(c.id)} className="text-[11px] text-white/40 hover:text-rose-200">
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={`block ${full ? "sm:col-span-2" : ""}`}>
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-white/40">{label}</span>
      {children}
    </label>
  );
}
