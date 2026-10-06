"use client";

import { useRef } from "react";
import { PaymentProvider, usePaymentFlow } from "@/lib/hooks/usePayment";
import { useWallet } from "@/lib/hooks/useWallet";
import { Hero, HowItWorks } from "@/components/landing/Hero";
import { PaymentComposer } from "@/components/composer/PaymentComposer";
import { ConnectButton } from "@/components/wallet/WalletBar";
import { Bolt, Shield } from "@/components/ui/Icons";

function ModeSwitch() {
  const { mode, setMode } = usePaymentFlow();
  return (
    <div className="flex rounded-2xl border border-white/[0.08] bg-ink-900/60 p-0.5 text-xs">
      {(["demo", "live"] as const).map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          className={`rounded-xl px-3 py-1.5 font-medium capitalize transition ${
            mode === m ? "bg-white/[0.09] text-white" : "text-white/45 hover:text-white/75"
          }`}
        >
          {m === "demo" ? "Demo" : "Live"}
        </button>
      ))}
    </div>
  );
}

function Shell() {
  const flow = usePaymentFlow();
  const wallet = useWallet(flow.network);
  const composerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-white/[0.05] bg-ink-950/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-mono to-mono-deep text-sm font-black text-white shadow-glow">
              ⌁
            </span>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight text-white">Intent Pay</div>
              <div className="hidden text-[10px] uppercase tracking-[0.16em] text-white/35 sm:block">
                Intent-based payments · Monad
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <ModeSwitch />
            <ConnectButton
              status={wallet.status}
              address={wallet.address}
              hasProvider={wallet.hasProvider}
              onConnect={wallet.connect}
              onDisconnect={wallet.disconnect}
            />
          </div>
        </div>
        {wallet.error && (
          <div className="mx-auto max-w-5xl px-5 pb-2">
            <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-200/90">
              {wallet.error}
            </p>
          </div>
        )}
      </header>

      <main className="pb-20">
        <Hero onTry={() => composerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />

        <div ref={composerRef} className="mx-auto mt-10 max-w-5xl scroll-mt-20 px-5">
          <PaymentComposer networkLabel={flow.network === "mainnet" ? "Monad" : "Monad Testnet"} />
        </div>

        <HowItWorks />

        <section className="mx-auto mt-14 max-w-5xl px-5">
          <div className="card-flat flex flex-col gap-3 p-4 text-xs text-white/45 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-emerald-300/70" />
              Live mode reads real Monad balances and quotes real Uniswap V3 routes. Demo mode uses
              clearly labelled sample data.
            </span>
            <span className="flex items-center gap-2">
              <Bolt className="h-4 w-4 text-mono-soft" /> Built on Monad · chain id 143
            </span>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function AppShell() {
  return (
    <PaymentProvider initialMode="demo">
      <Shell />
    </PaymentProvider>
  );
}
