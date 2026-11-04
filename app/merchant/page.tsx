import type { Metadata } from "next";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { WalletProvider } from "@/lib/hooks/useWallet";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { MerchantConsole } from "@/components/merchant/MerchantConsole";

export const metadata: Metadata = {
  title: "Merchant console — Intent Pay",
  description:
    "Create crypto payment links and watch orders settle on Monad. A checkout console built on the public Intent Pay developer API.",
  robots: { index: false, follow: false },
};

/**
 * `/merchant` — the merchant console.
 *
 * A thin client of the versioned `/api/v1` API: it creates an intent, wraps it in
 * a checkout, and renders the payment link and its QR. It holds no server-side
 * state and no secret beyond the operator's own API key, which lives only in the
 * browser.
 */
export default function MerchantPage() {
  return (
    <ErrorBoundary scope="app">
      <WalletProvider>
        <div className="min-h-dvh">
          <header className="sticky top-0 z-40 border-b border-white/[0.05] bg-ink-950/70 backdrop-blur-xl">
            <div className="mx-auto flex max-w-3xl items-center gap-2.5 px-5 py-3.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-mono to-mono-deep text-sm font-black text-white shadow-glow">
                ⌁
              </span>
              <div className="leading-tight">
                <div className="text-sm font-semibold tracking-tight text-white">Intent Pay</div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">Merchant console</div>
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-3xl px-5 py-8">
            <h1 className="text-xl font-semibold tracking-tight text-white">Accept crypto payments</h1>
            <p className="mt-1 text-sm text-white/50">
              Create a payment link your customers pay with their own wallet. You receive the exact
              amount and asset you asked for; settlement is verified on-chain.
            </p>
            <div className="mt-6">
              <MerchantConsole />
            </div>
          </main>
          <SiteFooter />
        </div>
      </WalletProvider>
    </ErrorBoundary>
  );
}
