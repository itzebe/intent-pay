import type { Metadata } from "next";
import Link from "next/link";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MarketingShell, Section } from "@/components/landing/MarketingShell";
import { VerifyClient } from "@/components/developer/VerifyClient";

export const metadata: Metadata = {
  title: "Verify your email — Intent Pay",
  description: "Open your verification link to receive your Intent Pay API key.",
  robots: { index: false, follow: false },
};

/**
 * `/developer/verify` — the verification-link landing page.
 *
 * The emailed link points here with `?token=…`. The token is exchanged for the
 * account's first API key, which is shown once. The page holds no state beyond
 * the token in the URL and never stores the key it receives.
 */
export default function VerifyPage() {
  return (
    <MarketingShell
      eyebrow="Developer portal"
      title="Confirm your email"
      intro="Opening your verification link confirms the address and issues your first API key. The key is shown once, here."
      actions={
        <Link href="/developer" className="btn-ghost">
          Back to the portal
        </Link>
      }
    >
      <Section title="Verification">
        <ErrorBoundary scope="app">
          <div className="mx-auto max-w-lg">
            <VerifyClient />
          </div>
        </ErrorBoundary>
      </Section>
    </MarketingShell>
  );
}
