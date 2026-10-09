import type { Metadata } from "next";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { DocSection, P, UL, LI, Code, Callout } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Developers — Intent Pay",
  description:
    "Repository layout, commands, HTTP routes and configuration for Intent Pay, an intent-based payment app on Monad.",
};

export default function Developers() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="Developers"
        title="Working on Intent Pay"
        intro="How the repository is organised, how to run it, and how the pieces fit together."
      />

      <DocSection title="Commands">
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`npm install      # install dependencies
npm run dev      # dev server on http://localhost:3000
npm test         # vitest (unit + component tests)
npm run build    # production build + typecheck

npx tsc --noEmit --noUnusedLocals --noUnusedParameters   # strict typecheck`}
          </pre>
        </div>
        <Callout tone="info" title="Build vs dev">
          <Code>next dev</Code> and <Code>next build</Code> share the <Code>.next/</Code> directory.
          Running a build while the dev server is live can break its module cache; restart the dev
          server (or remove <Code>.next</Code>) afterwards.
        </Callout>
      </DocSection>

      <DocSection title="Repository layout">
        <UL>
          <LI><Code>lib/domain/*</Code> — pure domain logic: intent, validation, canonical state, readiness, source selection, freshness, protection, token state and risk, partial-balance split, diagnostics.</LI>
          <LI><Code>lib/nlp/*</Code> — the natural-language intent engine (parser, schema, engine, question, handoff, optional LLM).</LI>
          <LI><Code>lib/providers/*</Code> — the routing provider interface and the live Uniswap V3 engine.</LI>
          <LI><Code>lib/server/*</Code> — server-only concerns: quote orchestration, balances/discovery, pricing, diagnostics, optimizer.</LI>
          <LI><Code>lib/execution/*</Code> — plan construction, ABIs, execution, the signing guard and delivery verification.</LI>
          <LI><Code>lib/hooks/*</Code> — React hooks for wallet, payment flow, optimizer and capabilities.</LI>
          <LI><Code>app/api/*</Code> — HTTP routes (quote, balances, tokens, optimize, nlp, partial, capabilities, diagnostics, health).</LI>
          <LI><Code>components/*</Code> — the UI: composer, review sheet, wallet bar, landing, docs.</LI>
        </UL>
      </DocSection>

      <DocSection title="HTTP routes">
        <UL>
          <LI><Code>POST /api/quote</Code> — price a payment without a wallet (fastest way to exercise routing).</LI>
          <LI><Code>GET /api/balances</Code> — real, on-chain-confirmed balances for an account, with source status.</LI>
          <LI><Code>GET /api/tokens</Code> — token catalog / search / single-address resolution with state and routability.</LI>
          <LI><Code>POST /api/optimize</Code> — rank the wallet&apos;s assets for the current intent.</LI>
          <LI><Code>POST /api/nlp</Code> — parse a natural-language payment request.</LI>
          <LI><Code>POST /api/partial</Code> — build a partial-balance split plan.</LI>
          <LI><Code>GET /api/capabilities</Code> and <Code>GET /api/diagnostics</Code> — provider configuration and reachability.</LI>
        </UL>
        <P>Example — exercise routing directly:</P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`curl -s -X POST http://localhost:3000/api/quote \\
  -H 'Content-Type: application/json' \\
  -d '{
    "recipient": "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
    "receiveToken": "USDC", "receiveAmount": "5",
    "amountMode": "recipient_receives",
    "payToken": "USDT", "mode": "live", "network": "mainnet"
  }'`}
          </pre>
        </div>
      </DocSection>

      <DocSection title="Configuration">
        <P>
          Everything token, chain and provider related is configuration-driven.{" "}
          <Code>.env.example</Code> documents every key; every value is optional and the app degrades
          honestly when a provider is absent. Gas is always paid in MON by the standard EOA path —
          there is no paymaster or account-abstraction configuration.
        </P>
        <UL>
          <LI><Code>MONAD_RPC_URL</Code> / <Code>NEXT_PUBLIC_MONAD_RPC_URL</Code> — RPC transport.</LI>
          <LI><Code>ALCHEMY_API_KEY</Code> — Alchemy RPC and the Alchemy Prices source (not gas abstraction).</LI>
          <LI><Code>ZERION_API_KEY</Code> — wallet asset discovery and USD valuation.</LI>
          <LI><Code>NEXT_PUBLIC_SLIPPAGE_BPS</Code> / <Code>NEXT_PUBLIC_MAX_PRICE_IMPACT_BPS</Code> — execution-protection thresholds.</LI>
          <LI><Code>INTENT_LLM_*</Code> — optional gap-filling for the natural-language parser.</LI>
        </UL>
      </DocSection>

      <DocSection title="Testing conventions">
        <UL>
          <LI>Prefer testing real code paths; avoid mocks.</LI>
          <LI>Tests that touch the token registry or a cached provider must use unique addresses/keys per test, or they leak state between cases.</LI>
          <LI>Live-network tests are gated behind environment flags and mirror production setup in <Code>beforeAll</Code>.</LI>
        </UL>
      </DocSection>

      <DocSection title="Design principles">
        <UL>
          <LI>The provider is behind an interface; the UI never branches on it beyond the demo/live label.</LI>
          <LI>Never hardcode a token symbol in a component or route.</LI>
          <LI>Live mode must fail honestly (<Code>route_unavailable</Code>, <Code>unsupported_token</Code>) rather than fabricate a quote.</LI>
          <LI>Demo mode is always labelled and never produces a transaction hash.</LI>
          <LI>One canonical intent; no second payment store.</LI>
        </UL>
      </DocSection>
    </DocsShell>
  );
}
