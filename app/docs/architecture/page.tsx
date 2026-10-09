import type { Metadata } from "next";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { DocSection, P, UL, LI, Callout, Code } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Technical Architecture — Intent Pay",
  description:
    "The Intent Pay layered architecture: intent, natural language, wallet/balances, quote/routing, construction, execution, verification and the signing guard.",
};

export default function Architecture() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="Technical Architecture"
        title="A layered payment system"
        intro="Each layer has a single responsibility and is testable in isolation. Network access is confined to the server or the wallet client; the domain logic is pure."
      />

      <DocSection title="Layer map">
        <div className="space-y-3">
          {[
            ["Intent", "lib/domain/intent.ts, lib/domain/validation.ts, lib/domain/canonicalIntent.ts", "Defines the payment intent, validates it, and holds the single canonical payment state shared by every surface."],
            ["Natural language", "lib/nlp/*", "A deterministic offline parser (the authority), a state machine derived only from the structured draft, a one-question-at-a-time clarifier, an optional gap-filling LLM, and a handoff to the composer."],
            ["Wallet / balances", "lib/hooks/useWallet.ts, app/api/balances/route.ts", "Reads the connected account and its real, on-chain-confirmed balances plus discovered holdings."],
            ["Quote / routing", "lib/providers/*, lib/server/quote.ts", "Behind getRoutingProvider: a demo provider and the live Uniswap V3 provider share one interface. The UI never branches on the provider beyond the demo/live label."],
            ["Construction", "lib/execution/plan.ts, lib/execution/abis.ts", "Turns a quote into explicit steps that carry real on-chain bounds and the correct router selectors."],
            ["Execution", "lib/execution/execute.ts", "Submits the plan through the user's wallet and tracks per-step results."],
            ["Verification", "lib/execution/verify.ts", "Proves the recipient's on-chain transfer from the confirmed receipt against the enforced minimum."],
            ["Signing guard", "lib/execution/signGuard.ts", "The only path to a signature; re-validates everything from fresh data immediately before signing."],
          ].map(([name, files, desc]) => (
            <div key={name} className="card-flat p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-white">{name}</span>
                <span className="font-mono text-[11px] text-white/40">{files}</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-white/50">{desc}</p>
            </div>
          ))}
        </div>
      </DocSection>

      <DocSection title="Configuration-driven, never hardcoded">
        <P>
          Tokens, chains and Uniswap deployments all come from configuration —{" "}
          <Code>lib/config/tokens.ts</Code>, <Code>lib/config/chains.ts</Code> and{" "}
          <Code>lib/providers/constants.ts</Code>. No component or route hardcodes a token symbol, so
          a token that is not shipped in source can still flow through exactly like a seed token.
        </P>
      </DocSection>

      <DocSection title="Server and client boundaries">
        <UL>
          <LI>
            <strong className="text-white/80">Server:</strong> RPC reads, market pricing, provider
            probes, token discovery and metadata reads. Secrets stay server-side.
          </LI>
          <LI>
            <strong className="text-white/80">Client:</strong> the composer, the review sheet, the
            signing guard and the wallet client. The client never holds a key or a provider secret.
          </LI>
          <LI>
            <strong className="text-white/80">Shared, pure:</strong> intent math, freshness,
            source-selection rules, the plan builder, the pricing state machine and the risk classifier
            are pure so the same rules run in the browser, on the server and in tests.
          </LI>
        </UL>
      </DocSection>

      <DocSection title="Routing engine">
        <P>
          The live routing engine discovers Uniswap V3 pools across all fee tiers on Monad and supports
          both exact-output and exact-input modes. Notable properties the implementation enforces:
        </P>
        <UL>
          <LI>every fee tier is quoted — a token can have a low-fee pool that reverts while a higher-fee pool holds the real liquidity;</LI>
          <LI>graph reuse is keyed on probed basis tokens, so a freshly discovered token is genuinely probed rather than assumed;</LI>
          <LI>the native MON is a basis token (pooled as WMON) and is the usual intermediate for multi-hop routes;</LI>
          <LI>the reported rate is a human rate, decimal-adjusted, never raw base units;</LI>
          <LI>an unavailable route fails honestly with <Code>route_unavailable</Code> rather than a fabricated quote.</LI>
        </UL>
      </DocSection>

      <DocSection title="Execution protection, in code">
        <UL>
          <LI>every swap step carries a real on-chain <Code>amountOutMinimum</Code> / <Code>amountInMaximum</Code>;</LI>
          <LI>the Monad SwapRouter02 has no <Code>deadline</Code> parameter, and the implementation does not add one;</LI>
          <LI>a route above the price-impact ceiling is blocked before signing;</LI>
          <LI>quote freshness is enforced off-chain, and the guard refuses a stale quote and rebuilds the calldata.</LI>
        </UL>
      </DocSection>

      <DocSection title="Testing">
        <Callout tone="info" title="Test structure">
          The repository uses <Code>vitest</Code>. Pure domain logic (math, validation, path, pricing,
          token state/risk, source selection, plan economics, diagnostics, freshness) is unit-tested.
          Component flows (the composer and review) are tested with <Code>@testing-library/react</Code>.
          A small set of live-network tests are opt-in behind environment flags, because they require
          real Monad access.
        </Callout>
      </DocSection>
    </DocsShell>
  );
}
