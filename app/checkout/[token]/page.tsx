import type { Metadata } from "next";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { WalletProvider } from "@/lib/hooks/useWallet";
import { CheckoutClient } from "@/components/checkout/CheckoutClient";

export const metadata: Metadata = {
  title: "Pay — Intent Pay",
  description: "Complete your payment with your own wallet on Monad Mainnet.",
  // A payment link is private to the customer who holds it; keep it out of search.
  robots: { index: false, follow: false },
};

/**
 * `/checkout/:token` — the customer's payment page.
 *
 * Server-rendered shell, client-driven payment. It carries no credential: the
 * token in the URL authenticates the order, and the customer's own wallet signs.
 * A `WalletProvider` is mounted so the shared wallet UI (picker, account/chain
 * handling) works exactly as it does in the main app.
 */
export default async function CheckoutPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <ErrorBoundary scope="app">
      <WalletProvider>
        <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-5 py-10">
          <div className="mb-5 flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-mono to-mono-deep text-sm font-black text-white shadow-glow">
              ⌁
            </span>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight text-white">Intent Pay</div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">
                Secure checkout · Monad
              </div>
            </div>
          </div>
          <CheckoutClient token={token} />
        </main>
      </WalletProvider>
    </ErrorBoundary>
  );
}
