import type { Metadata } from "next";
import Link from "next/link";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MarketingShell, Section, NextStep } from "@/components/landing/MarketingShell";
import { DeveloperPortal } from "@/components/developer/DeveloperPortal";

export const metadata: Metadata = {
  title: "Developer portal — Intent Pay",
  description:
    "Create an Intent Pay developer account, verify your email and manage API keys. Self-service signup on Monad Mainnet.",
};

/**
 * `/developer` — the self-service developer portal.
 *
 * A real, public signup: create an account, verify your email, receive your first
 * API key once, and manage (create / rotate / revoke) keys thereafter. It is a
 * thin client of the public `/api/v1/developers*` API, so the portal and the
 * documented contract cannot drift.
 */
export default function DeveloperPage() {
  return (
    <MarketingShell
      eyebrow="Developer portal"
      title="Get an API key in two minutes"
      intro="Create an account with your email, open the verification link, and receive your first API key. The portal is a client of the same public API you will integrate against — nothing here is a special path."
      actions={
        <>
          <Link href="/docs/quickstart" className="btn-primary">
            Quickstart
          </Link>
          <Link href="/docs/api" className="btn-ghost">
            API reference
          </Link>
        </>
      }
    >
      <Section title="Your account">
        <ErrorBoundary scope="app">
          <div className="mx-auto max-w-lg">
            <DeveloperPortal />
          </div>
        </ErrorBoundary>
      </Section>

      <Section title="What you get">
        <div className="space-y-3 text-sm leading-relaxed text-white/55">
          <p className="text-pretty">
            A developer account owns its API keys, intents and webhooks, and no account can see another&apos;s.
            A credential prepares a transaction — it can never sign or send one. Your user&apos;s wallet
            authorizes every payment locally.
          </p>
          <p className="text-pretty">
            Keys are shown <strong className="text-white/80">once</strong>. Store yours securely; it cannot be
            retrieved later. You can create additional keys, rotate one (the old key is revoked immediately)
            or revoke one at any time.
          </p>
        </div>
      </Section>

      <Section title="Next">
        <div className="grid gap-3 sm:grid-cols-2">
          <NextStep href="/docs/quickstart" label="Quickstart" body="Authenticate, create an intent, prepare, submit and verify" />
          <NextStep href="/docs/api" label="API reference" body="Every endpoint, request and response" />
          <NextStep href="/docs/checkout" label="Merchant checkout" body="The two-step intent → checkout model" />
          <NextStep href="/docs/security" label="Security model" body="Signing guard, bounds and honest limits" />
        </div>
      </Section>
    </MarketingShell>
  );
}
