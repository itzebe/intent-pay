import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { P, Callout, Code } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "FAQ — Intent Pay",
  description:
    "Direct answers about Intent Pay: tokens, gas, fees, safety, routes, network support and verification.",
};

const FAQ_ITEMS: { q: string; a: ReactNode }[] = [
  {
    q: "What is Intent Pay?",
    a: <>An intent-based payment application on Monad. You state what the recipient should receive; the app works out which asset you spend, the route, and the transaction, and you approve it in your own wallet.</>,
  },
  {
    q: "Is it a DEX or a swap interface?",
    a: <>No. It is a payment app. Routing is machinery underneath. The interface says “Pay”, not “Swap”.</>,
  },
  {
    q: "Can I pay with any token?",
    a: <>Any compatible token on Monad can be discovered and used when your balance and a real execution path support the operation. A discovered token with no liquidity cannot be converted, though a direct transfer may still work. Discovery is not a claim of safety, liquidity or tradability.</>,
  },
  {
    q: "Do I need MON for gas?",
    a: <>Yes. Gas is always paid in native MON through your own injected wallet. There is no sponsored, ERC-20 or account-abstracted gas path. If you hold no MON, the app tells you before you start.</>,
  },
  {
    q: "Is Intent Pay gasless?",
    a: <>No. It is not a gasless product, and it does not claim to be.</>,
  },
  {
    q: "Does Intent Pay charge a fee?",
    a: <>No service fee is currently charged. Service-fee collection is planned and, if added, would be displayed before you authorize a payment.</>,
  },
  {
    q: "Can I send to another chain (for example, to a Solana wallet)?",
    a: <>No. Intent Pay is Monad-only. It is not a bridge and does not claim cross-chain delivery.</>,
  },
  {
    q: "How do I know the recipient actually received the funds?",
    a: <>After the transaction confirms, the app verifies the recipient&apos;s on-chain transfer from the receipt against the minimum the transaction enforced. Success is only shown after that verification. An unprovable delivery is shown as unverified, never as success.</>,
  },
  {
    q: "Does the AI control the payment?",
    a: <>No. A deterministic, offline parser interprets the request, and deterministic validation plus the signing guard govern execution. The AI can only fill gaps and can never supply a price, route, address or transaction.</>,
  },
  {
    q: "Will I always get the best route?",
    a: <>The app selects the best available route among the quotes it evaluated, weighing output, network cost, price impact and execution feasibility. It does not claim to find the globally optimal route, and it never silently chooses a route that materially differs from the one you reviewed.</>,
  },
  {
    q: "How does it protect against sandwich/MEV attacks?",
    a: <>Through the transaction itself: every swap carries an on-chain minimum output (or maximum input), a route above the price-impact ceiling is blocked before signing, and a stale quote is refused and the calldata rebuilt. The app reports MEV-protected submission as unavailable on Monad rather than showing a cosmetic badge.</>,
  },
  {
    q: "Can the app sign for me or move funds without my approval?",
    a: <>No. The app never holds your keys, never signs on your behalf, and cannot bypass wallet authorization. It prepares a transaction; your wallet approves it.</>,
  },
  {
    q: "What is demo mode?",
    a: <>A clearly labelled mode that uses deterministic sample data so the flow can be explored without a wallet. It never produces a transaction hash and never claims a real transaction.</>,
  },
  {
    q: "Where can I read the full design?",
    a: <>See the <Code>/docs/litepaper</Code>. It describes the implementation as built, including its current limits.</>,
  },
];

export default function FAQ() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="FAQ"
        title="Frequently asked questions"
        intro="Straight answers, including where the product does not do something."
      />

      <div className="space-y-3">
        {FAQ_ITEMS.map((item) => (
          <div key={item.q} className="card-flat p-4">
            <h2 className="text-sm font-semibold text-white">{item.q}</h2>
            <div className="mt-1.5 text-sm leading-relaxed text-white/55">
              <P>{item.a}</P>
            </div>
          </div>
        ))}
      </div>

      <Callout tone="info" title="Still unsure?">
        Read <Code>/docs/security</Code> for the protection model and <Code>/docs/litepaper</Code>{" "}
        §12 for exactly which capabilities are verified, which are implemented but not universally
        verified, and which are planned.
      </Callout>
    </DocsShell>
  );
}
