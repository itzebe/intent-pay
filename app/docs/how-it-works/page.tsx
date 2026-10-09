import type { Metadata } from "next";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { DocSection, P, UL, OL, LI, Callout, Code } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "How It Works — Intent Pay",
  description:
    "The Intent Pay payment journey: from expressing an intent to verified onchain delivery, step by step.",
};

export default function HowItWorks() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="How It Works"
        title="From intent to verified delivery"
        intro="A single page describing the exact journey a payment takes, and what the system checks at each step."
      />

      <DocSection title="The journey">
        <OL>
          <LI>
            <strong className="text-white/80">Connect a wallet.</strong> The app detects the account
            and its active network, and confirms it is Monad mainnet (chain id 143).
          </LI>
          <LI>
            <strong className="text-white/80">Express the intent.</strong> Enter a recipient, an
            amount, and the token the recipient should receive — by form, or in plain English in the
            intent bar (for example, &ldquo;Send $10 worth of USDC to 0x…&rdquo;).
          </LI>
          <LI>
            <strong className="text-white/80">Read reality.</strong> The app loads the wallet&apos;s real
            balances (on-chain-confirmed), prices the assets, and finds routes from the assets held to
            the asset requested.
          </LI>
          <LI>
            <strong className="text-white/80">Choose the source.</strong> A deterministic engine picks
            which asset to spend and states why in plain language. If nothing is executable, it says
            exactly why.
          </LI>
          <LI>
            <strong className="text-white/80">Prepare the transaction.</strong> The plan is built with
            a real on-chain minimum output (or maximum input) so the recipient cannot be short-changed
            by the route.
          </LI>
          <LI>
            <strong className="text-white/80">Review.</strong> You see the recipient, what they
            receive, what you spend, the estimated network fee and any warnings. Advanced routing
            detail is available under an expandable section, hidden by default.
          </LI>
          <LI>
            <strong className="text-white/80">Confirm and send.</strong> Your wallet is asked to
            authorize the exact prepared transaction.
          </LI>
          <LI>
            <strong className="text-white/80">Follow status.</strong> The app tracks the real
            transaction, and reports success only after the receipt confirms and the recipient&apos;s
            transfer is verified.
          </LI>
        </OL>
      </DocSection>

      <DocSection title="Two intent modes">
        <UL>
          <LI>
            <strong className="text-white/80">Recipient receives (default).</strong> You fix what they
            get; the app prices what you pay.
          </LI>
          <LI>
            <strong className="text-white/80">I spend.</strong> You fix what you pay; the app shows
            what they receive. A shortfall in &ldquo;I spend&rdquo; mode is expected; exact-payment
            protection only fires on over-delivery.
          </LI>
        </UL>
      </DocSection>

      <DocSection title="What happens between review and signature">
        <P>
          The signing guard is the only path to a signature. Immediately before the wallet is asked to
          sign, it:
        </P>
        <OL>
          <LI>reads the current canonical intent and captures its version key;</LI>
          <LI>fetches fresh balances and a fresh quote;</LI>
          <LI>rebuilds the transaction plan from those fresh values;</LI>
          <LI>re-reads the intent and confirms it did not change mid-preparation;</LI>
          <LI>confirms the quote is still fresh and the price impact is acceptable;</LI>
          <LI>confirms the balances still cover the payment and the MON network fee;</LI>
          <LI>confirms every swap step carries a real output bound;</LI>
          <LI>re-reads the wallet account and the intent one final time.</LI>
        </OL>
        <P>
          Any mismatch aborts with a specific, human-readable reason. Calldata is never reused from an
          earlier build.
        </P>
      </DocSection>

      <DocSection title="Errors that recover, and errors that stop">
        <UL>
          <LI>
            <strong className="text-white/80">Recoverable:</strong> a moved price, a stale quote, a
            drained balance, an account switch. The review stays in place, shows the specific reason,
            refreshes the quote, and offers a retry.
          </LI>
          <LI>
            <strong className="text-white/80">Stopping:</strong> no route, an unsupported token, a
            rejected signature, a network mismatch, insufficient MON. The app explains the problem
            before execution.
          </LI>
        </UL>
        <Callout tone="info" title="Never a silent resubmission">
          If a transaction may already have been broadcast, the app does not automatically resubmit
          it. An unprovable delivery is shown as unverified rather than as success.
        </Callout>
      </DocSection>

      <DocSection title="A note on gas">
        <P>
          Every payment is executed through your own injected wallet and the network fee is paid in
          native MON. There is no sponsored or ERC-20 gas path. If your wallet does not hold enough
          MON, the app tells you before you start, rather than implying gas will be covered another
          way. See <Code>/docs/litepaper</Code> §10.
        </P>
      </DocSection>
    </DocsShell>
  );
}
