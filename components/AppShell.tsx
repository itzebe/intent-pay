"use client";

import { useEffect, useRef } from "react";
import { PaymentProvider, usePaymentFlow } from "@/lib/hooks/usePayment";
import { useWallet, WalletProvider } from "@/lib/hooks/useWallet";
import { Hero } from "@/components/landing/Hero";
import { Lifecycle, Pathways, WhyMonad } from "@/components/landing/HomeSections";
import { AdvancedDiagnostics } from "@/components/landing/AdvancedDiagnostics";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { PaymentComposer } from "@/components/composer/PaymentComposer";
import { ConnectButton } from "@/components/wallet/WalletBar";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ReferralPanel } from "@/components/referral/ReferralPanel";
import { captureReferralFromUrl } from "@/lib/referral/useReferral";
import { Bolt, Shield } from "@/components/ui/Icons";

function Shell() {
  const flow = usePaymentFlow();
  const wallet = useWallet(flow.intent.network);
  const composerRef = useRef<HTMLDivElement>(null);

  // Capture `?ref=` once, as early as possible, so the referral survives the
  // connect step and any reload. Never blocks the payment flow.
  useEffect(() => {
    captureReferralFromUrl(window.location.search);
  }, []);

  return (
    <div className="min-h-dvh">
      <SiteHeader actions={<ConnectButton />} />
      {wallet.error && (
        <div className="mx-auto max-w-6xl px-5 pb-2 pt-2">
          <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-200/90">
            {wallet.error}
          </p>
        </div>
      )}

      <main className="pb-20">
        <Hero onTry={() => composerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />

        <div id="pay" ref={composerRef} className="mx-auto mt-12 max-w-5xl scroll-mt-20 px-5">
          <ErrorBoundary scope="composer">
            <PaymentComposer networkLabel="Monad" />
          </ErrorBoundary>
          <AdvancedDiagnostics network={flow.intent.network} />
        </div>

        <Pathways />

        <Lifecycle />

        <WhyMonad />

        <ReferralPanel address={wallet.address} walletClient={wallet.walletClient} />

        <section className="mx-auto mt-14 max-w-6xl px-5">
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

      <SiteFooter />
    </div>
  );
}

export default function AppShell() {
  return (
    <ErrorBoundary scope="app">
      <WalletProvider>
        <PaymentProvider>
          <Shell />
        </PaymentProvider>
      </WalletProvider>
    </ErrorBoundary>
  );
}
