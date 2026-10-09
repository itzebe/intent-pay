import type { Metadata } from "next";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { DocSection, P, UL, LI, Callout, Code } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Security & Trust — Intent Pay",
  description:
    "How Intent Pay protects a payment: on-chain output bounds, a price-impact guard, quote freshness, the signing guard and delivery verification — plus honest limits.",
};

export default function Security() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="Security & Trust"
        title="The transaction enforces the outcome"
        intro="Intent Pay's security model is that the on-chain transaction, not the interface, guarantees what the recipient receives. The interface's job is to refuse to sign anything it cannot stand behind."
      />

      <DocSection title="On-chain output bound">
        <P>
          Every swap step carries a real on-chain bound: <Code>amountOutMinimum</Code> for exact-input
          swaps and <Code>amountInMaximum</Code> for exact-output swaps. The bound is derived from a
          clamped slippage tolerance — 50 basis points (0.5%) by default, with a hard ceiling of 500
          basis points (5%). The signing guard refuses to sign a swap that has no bound.
        </P>
        <P>
          The figure labelled &ldquo;minimum received&rdquo; in the review is a display of that bound; it is
          never itself the protection. The calldata is.
        </P>
      </DocSection>

      <DocSection title="Price-impact guard">
        <P>
          A route whose live price impact exceeds the configured ceiling (300 basis points, 3%, by
          default) is blocked before signing. Slippage is never widened to rescue a bad route — that
          is exactly what enables a sandwich. When a price impact cannot be measured, the app does not
          invent a number; an unmeasurable impact does not block, but it is never presented as zero.
        </P>
      </DocSection>

      <DocSection title="Quote freshness">
        <P>
          A quote is a live, perishable value with a hard 20-second limit and a 15-second proactive
          refresh. A stale quote disables Review/Confirm and is refreshed. If a refresh fails
          transiently while the last-known-good quote for the current intent is still usable, the app
          keeps that quote (so staleness keeps ageing honestly) and retries after a short backoff. A
          definitive failure — no route, unsupported token — clears the quote so the honest error
          shows.
        </P>
      </DocSection>

      <DocSection title="The signing guard">
        <P>
          <Code>prepareSigning</Code> is the only path to a signature. Immediately before the wallet is
          asked to sign, it fetches fresh balances and a fresh quote, re-reads the canonical intent and
          the wallet account, re-checks freshness and price impact, re-checks balance and gas coverage,
          rebuilds the calldata from the fresh quote, asserts the on-chain bound, and re-reads the
          intent a final time. Any change aborts with a specific reason. Calldata is never reused from
          an earlier build.
        </P>
        <P>
          The guard also refuses a payment the interface is not showing: it compares the displayed
          intent fingerprint to the canonical intent, so a UI desync cannot result in signing a
          transaction that differs from what was reviewed.
        </P>
      </DocSection>

      <DocSection title="Delivery verification">
        <P>
          After a transaction is confirmed, the app proves the recipient&apos;s actual on-chain transfer
          from the receipt against the minimum the transaction enforced. A reverted transaction is
          failed. An unprovable delivery is reported as unverified — never as success. The interface
          does not treat a closed wallet prompt as a completed payment.
        </P>
      </DocSection>

      <DocSection title="What we do not claim">
        <UL>
          <LI>We do not claim tokens are audited or safe. Discovery is not an endorsement.</LI>
          <LI>We do not claim MEV-protected submission is active. Monad has no dapp-controllable private submission path, and a private endpoint cannot be forced onto an injected wallet.</LI>
          <LI>We do not claim any security audit, partnership or third-party certification that has not happened.</LI>
          <LI>We do not claim gas is sponsored. Gas is paid in MON by your wallet.</LI>
          <LI>We do not claim the app ever holds your keys. It never does.</LI>
        </UL>
      </DocSection>

      <DocSection title="User control">
        <P>
          Your wallet authorizes every transaction. The app builds a payment for you to approve; it
          cannot sign on your behalf, bypass wallet authorization, or alter approved payment details
          after confirmation. Demo mode is labelled everywhere and never produces a transaction hash
          or claims a real transaction.
        </P>
        <Callout tone="ok" title="Honest failure by design">
          A route that does not exist is reported as unavailable. A token that merely resolves is not
          presented as payable. A price that cannot be trusted is never shown as $0.00. The system
          fails honestly rather than fabricating a result.
        </Callout>
      </DocSection>
    </DocsShell>
  );
}
