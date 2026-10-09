"use client";

import { useRef } from "react";
import { PaymentProvider, usePaymentFlow } from "@/lib/hooks/usePayment";
import { useWallet } from "@/lib/hooks/useWallet";
import { Hero, HowItWorks } from "@/components/landing/Hero";
import { AdvancedDiagnostics } from "@/components/landing/AdvancedDiagnostics";
import { LearnNav } from "@/components/landing/LearnNav";
import { PaymentComposer } from "@/components/composer/PaymentComposer";
import { ConnectButton } from "@/components/wallet/WalletBar";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Bolt, Shield } from "@/components/ui/Icons";

function Shell() {
  const flow = usePaymentFlow();
  const wallet = useWallet(flow.intent.network);
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
            <LearnNav />
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
          <ErrorBoundary scope="composer">
            <PaymentComposer networkLabel="Monad" />
          </ErrorBoundary>
          <AdvancedDiagnostics network={flow.intent.network} />
        </div>

        <HowItWorks />

        <section className="mx-auto mt-14 max-w-5xl px-5">
          <div className="card-flat flex flex-col gap-3 p-4 text-xs text-white/45 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-emerald-300/70" />
              Live on Monad Mainnet. Every balance, price, route and transaction is read from and
              written to the real chain.
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
    <PaymentProvider>
      <Shell />
    </PaymentProvider>
  );
}
