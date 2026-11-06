"use client";

import { useEffect, useState } from "react";
import { shortAddress } from "@/lib/format";
import { NETWORKS } from "@/lib/config/chains";
import { useWallet, type WalletOption } from "@/lib/hooks/useWallet";
import { ChevronDown, ExternalLink, Wallet, Warning } from "@/components/ui/Icons";
import { Modal } from "@/components/ui/Modal";

/** The Monad network label a chain id maps to, or a short fallback. */
function networkLabelFor(chainId: number | undefined): string {
  if (chainId === undefined) return "Unknown network";
  return chainId === NETWORKS.mainnet.chainId ? NETWORKS.mainnet.label : `Chain ${chainId}`;
}

function onMonad(chainId: number | undefined): boolean {
  return chainId === NETWORKS.mainnet.chainId;
}

/** A wallet's icon (data URI/URL) or a neutral glyph when it supplied none. */
function WalletGlyph({ wallet, size = 28 }: { wallet: WalletOption; size?: number }) {
  const [failed, setFailed] = useState(false);
  // Only same-origin/data icons are guaranteed by the CSP; an https icon on the
  // wallet's own host may be blocked, in which case we fall back to the glyph
  // rather than showing a broken image.
  const usable = wallet.icon && !failed && /^(data:|https?:)/.test(wallet.icon);
  if (usable) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={wallet.icon}
        alt=""
        width={size}
        height={size}
        className="rounded-lg"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="flex items-center justify-center rounded-lg bg-white/[0.06] text-white/60"
      style={{ width: size, height: size }}
    >
      <Wallet className="h-4 w-4" />
    </span>
  );
}

/**
 * Wallet picker. Lists every wallet the user can actually connect with — the
 * injected wallets discovered via EIP-6963 (MetaMask, Rabby, Coinbase Wallet,
 * …), the legacy `window.ethereum` provider, and WalletConnect when a project
 * id is configured. A wallet that cannot be used is shown disabled with the
 * real reason, never hidden.
 */
function WalletPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallet = useWallet();
  const [connectingId, setConnectingId] = useState<string | null>(null);

  // Re-scan every time the picker opens. A mobile in-app browser can inject its
  // provider long after first paint, and the user only opens this to connect —
  // so this is exactly when a missed late injection must be picked up.
  useEffect(() => {
    if (open) wallet.refresh();
    // `refresh` is stable; only `open` should retrigger the scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const injected = wallet.wallets.filter((w) => w.kind === "injected");
  const walletConnect = wallet.wallets.find((w) => w.kind === "walletconnect");

  const choose = async (w: WalletOption) => {
    if (!w.available) return;
    setConnectingId(w.id);
    // WalletConnect opens its own QR / deep-link dialog. Close this picker
    // first, or the customer sees two stacked dialogs and the QR is hidden
    // behind the picker — which on mobile read as "nothing happened".
    if (w.kind === "walletconnect") onClose();
    await wallet.connect(w.id);
    setConnectingId(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect a wallet">
      <p className="text-xs text-white/50">
        Choose how to connect. Intent Pay never asks for a seed phrase or private key — every
        signature happens in your own wallet.
      </p>

      <div className="mt-4 space-y-2">
        {injected.map((w) => (
          <button
            key={w.id}
            onClick={() => choose(w)}
            disabled={connectingId !== null}
            className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.08] bg-ink-900/50 px-3 py-3 text-left transition hover:border-white/20 hover:bg-white/[0.04] disabled:opacity-60"
          >
            <WalletGlyph wallet={w} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-white">{w.name}</span>
              <span className="block text-[11px] text-white/40">Detected in this browser</span>
            </span>
            {connectingId === w.id ? (
              <span className="text-[11px] text-white/50">Connecting…</span>
            ) : (
              <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-200/90">
                Detected
              </span>
            )}
          </button>
        ))}

        {walletConnect && (
          <button
            onClick={() => choose(walletConnect)}
            disabled={!walletConnect.available || connectingId !== null}
            className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.08] bg-ink-900/50 px-3 py-3 text-left transition hover:border-white/20 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <WalletGlyph wallet={walletConnect} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-white">{walletConnect.name}</span>
              <span className="block text-[11px] text-white/40">
                {walletConnect.available
                  ? "Scan a QR code with a mobile wallet"
                  : "Mobile & QR wallets"}
              </span>
            </span>
            {walletConnect.available ? (
              connectingId === walletConnect.id ? (
                <span className="text-[11px] text-white/50">Connecting…</span>
              ) : (
                <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white/50">
                  QR
                </span>
              )
            ) : (
              <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-200/90">
                Off
              </span>
            )}
          </button>
        )}
      </div>

      {/* Honest, actionable guidance when a path is unavailable. */}
      {injected.length === 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-white/[0.03] px-3 py-2.5 text-[11px] leading-relaxed text-white/50">
          <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-200/70" />
          <span>
            No browser wallet detected. Install a wallet such as MetaMask, Rabby, Coinbase Wallet
            or Trust Wallet, then reload this page.
          </span>
        </p>
      )}
      {walletConnect && !walletConnect.available && (
        <p className="mt-3 text-[11px] leading-relaxed text-white/40">{walletConnect.reason}</p>
      )}

      <button
        onClick={() => wallet.refresh()}
        className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[11px] text-white/45 transition hover:bg-white/[0.04] hover:text-white/70"
      >
        Installed a wallet? Rescan
      </button>
    </Modal>
  );
}

/**
 * Connect / connected control. One tap opens the wallet picker; once connected
 * it shows the real address, the network status, and safe disconnect.
 */
export function ConnectButton() {
  const wallet = useWallet();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  if (wallet.status === "connected" && wallet.address) {
    const wrongNetwork = !onMonad(wallet.chainId);
    return (
      <div className="relative">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex items-center gap-2 rounded-2xl border border-white/[0.09] bg-white/[0.03] py-2 pl-2.5 pr-3 transition hover:border-white/20"
          aria-label="Wallet menu"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              wrongNetwork
                ? "bg-amber-400"
                : "bg-emerald-400 shadow-[0_0_10px_2px_rgba(52,211,153,0.6)]"
            }`}
          />
          <span className="num font-mono text-xs text-white/85">{shortAddress(wallet.address)}</span>
          <ChevronDown className="h-3.5 w-3.5 text-white/45" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-12 z-30 w-60 overflow-hidden rounded-2xl border border-white/10 bg-ink-800/95 p-1.5 shadow-2xl backdrop-blur-xl">
            <div className="px-3 py-2">
              <div className="label">
                {wallet.kind === "walletconnect" ? "Connected via WalletConnect" : "Connected"}
              </div>
              <div className="num mt-0.5 break-all font-mono text-xs text-white/70">
                {wallet.address}
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-[11px]">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    wrongNetwork ? "bg-amber-400" : "bg-emerald-400"
                  }`}
                />
                <span className={wrongNetwork ? "text-amber-200/90" : "text-emerald-200/90"}>
                  {networkLabelFor(wallet.chainId)}
                </span>
              </div>
            </div>

            {wrongNetwork && (
              <div className="px-3 pb-2">
                <button
                  onClick={async () => {
                    setSwitching(true);
                    setSwitchError(null);
                    const res = await wallet.ensureMonad();
                    setSwitching(false);
                    if (!res.ok) setSwitchError(res.error.message);
                  }}
                  disabled={switching}
                  className="w-full rounded-xl bg-mono/90 px-3 py-2 text-xs font-medium text-white transition hover:bg-mono disabled:opacity-60"
                >
                  {switching ? "Switching…" : `Switch to ${NETWORKS.mainnet.label}`}
                </button>
                {switchError && (
                  <p className="mt-1.5 text-[11px] leading-snug text-amber-200/90">{switchError}</p>
                )}
              </div>
            )}

            <a
              href={`${NETWORKS.mainnet.explorer}/address/${wallet.address}`}
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center gap-1.5 rounded-xl px-3 py-2 text-left text-sm text-white/75 transition hover:bg-white/[0.06]"
            >
              View on explorer
              <ExternalLink className="h-3.5 w-3.5 text-white/40" />
            </a>

            <button
              onClick={() => {
                setMenuOpen(false);
                wallet.disconnect();
              }}
              className="w-full rounded-xl px-3 py-2 text-left text-sm text-white/75 transition hover:bg-white/[0.06]"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setPickerOpen(true)}
        disabled={wallet.status === "connecting"}
        className="btn-primary py-2.5 text-sm"
      >
        {wallet.status === "connecting" ? (
          "Connecting…"
        ) : (
          <>
            <Wallet className="h-4 w-4" />
            Connect wallet
          </>
        )}
      </button>
      <WalletPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </>
  );
}

/** Compact balance overview — deliberately not a wallet dashboard. */
export function BalanceOverview({
  balances,
  loading,
  connected = true,
}: {
  balances: { token: { symbol: string; tint: string; address?: string }; amount: string; usd: number }[];
  loading?: boolean;
  /** False when no wallet is connected — balances are *unknown*, not zero. */
  connected?: boolean;
}) {
  // External balance data is untrusted: a missing token, symbol, tint or a
  // non-numeric usd must degrade, never throw (a throw here unmounts the tree).
  const safe = (Array.isArray(balances) ? balances : []).filter(
    (b) => b && typeof b === "object" && b.token && typeof b.token === "object",
  );
  const usdOf = (b: (typeof safe)[number]) => (Number.isFinite(b.usd) ? b.usd : 0);
  const total = safe.reduce((s, b) => s + usdOf(b), 0);
  const funded = safe.filter((b) => usdOf(b) > 0);

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-ink-800/40 p-4">
      <div className="flex items-center justify-between">
        <span className="label">Your wallet</span>
        {/* Never show a verified $0.00 when we simply have no wallet. */}
        {connected && !loading ? (
          <span className="num text-sm font-semibold text-white">
            ${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        ) : (
          <span className="text-xs text-white/35">—</span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {!connected ? (
          <span className="text-xs text-white/40">Connect your wallet to see balances</span>
        ) : loading ? (
          <span className="text-xs text-white/40">Reading balances…</span>
        ) : funded.length === 0 ? (
          <span className="text-xs text-white/40">No supported balances</span>
        ) : (
          funded.map((b, i) => (
            <span key={b.token.symbol || b.token.address || i} className="flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: typeof b.token.tint === "string" && b.token.tint ? b.token.tint : "#8A92B2" }}
              />
              <span className="text-xs text-white/55">{b.token.symbol || "Unknown"}</span>
              <span className="num text-xs font-medium text-white/85">${usdOf(b).toFixed(2)}</span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}
