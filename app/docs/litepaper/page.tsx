import type { Metadata } from "next";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { DocSection, P, UL, OL, LI, Callout, Code } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Litepaper — Intent Pay",
  description:
    "The Intent Pay litepaper: intent-driven payments on Monad. Problem, approach, architecture, routing, execution, gas, security, current capabilities and roadmap.",
};

const TOC = [
  ["executive-summary", "1. Executive Summary"],
  ["problem", "2. Problem Statement"],
  ["approach", "3. Intent Pay's Approach"],
  ["intent-driven", "4. Intent-Driven Payments"],
  ["ux", "5. User Experience"],
  ["architecture", "6. Technical Architecture"],
  ["monad", "7. Monad Integration"],
  ["tokens", "8. Token Discovery and Routing"],
  ["execution", "9. Transaction Execution"],
  ["gas", "10. Gas Handling and Fees"],
  ["security", "11. Security and User Control"],
  ["capabilities", "12. Current Capabilities and Limitations"],
  ["roadmap", "13. Development Roadmap"],
  ["use-cases", "14. Potential Use Cases"],
  ["faq", "15. Frequently Asked Questions"],
  ["conclusion", "16. Conclusion"],
] as const;

export default function Litepaper() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="Litepaper"
        title="Intent Pay — intent-driven payments on Monad"
        intro="A design and status document. It describes the system that is actually implemented, marks what is verified versus planned, and avoids claims the repository cannot support."
      />

      <nav className="card-flat p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/35">
          Contents
        </div>
        <ol className="grid gap-x-6 gap-y-1 text-sm text-white/55 sm:grid-cols-2">
          {TOC.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`} className="hover:text-white">
                {label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <DocSection id="executive-summary" title="1. Executive Summary">
        <P>
          Intent Pay is an intent-based payment layer for the Monad blockchain. A user expresses an
          outcome — a recipient, an amount, and the token the recipient should receive — and the
          application determines the rest: which of the user&apos;s balances to spend, how much of it is
          required, the conversion route, the bounds that protect the swap, the transaction to
          construct, and how to prove the recipient actually received the funds.
        </P>
        <P>
          The product is deliberately not a swap interface. The interface says “Pay”, not “Swap”. The
          user reviews a payment — recipient, amount, fee, route — and authorizes it once in their own
          wallet. Routing, liquidity, fee tiers and calldata never surface in the primary flow.
        </P>
        <P>
          The system runs on Monad mainnet (chain id 143) and executes through the user&apos;s own
          injected wallet. Gas is always paid in native MON. Routing uses live Uniswap V3 pools on
          Monad. Tokens are discovered from real chain state rather than a fixed allow-list. Every
          step is built to fail honestly: an unavailable route is reported, not fabricated; a token
          that exists is not presented as tradable unless a real route and price exist.
        </P>
        <Callout tone="ok" title="What is verified today">
          Live routing, quoting, plan construction and signing-time re-validation are implemented and
          covered by the repository&apos;s test suite. Execution and delivery verification are implemented
          for the standard EOA path. Token discovery, pricing and the natural-language intent engine
          are implemented and tested; a small number of behaviours require live network access and are
          gated behind opt-in test flags (see section 12).
        </Callout>
      </DocSection>

      <DocSection id="problem" title="2. Problem Statement">
        <P>
          Making a crypto payment is unreasonably hard for anyone who is not a trader. The recipient
          usually wants a specific token. The sender usually holds a different one. Bridging that gap
          by hand forces the sender to understand swapping, liquidity pools, routing, fee tiers,
          slippage, gas, token approvals and transaction construction.
        </P>
        <UL>
          <LI>The recipient&apos;s need (&ldquo;I need USDC&rdquo;) and the sender&apos;s holdings (&ldquo;I have MON&rdquo;) are different problems.</LI>
          <LI>Swap interfaces optimise for trading, not for paying a specific person a specific value.</LI>
          <LI>A raw token list or hardcoded allow-list cannot represent the long tail of tokens deployed on a chain.</LI>
          <LI>Honest failure is rare: interfaces often imply a capability (any token, no gas, automatic conversion) that is not actually available.</LI>
          <LI>Users cannot tell whether a transaction will do what it claims until after they sign — and sometimes not even then.</LI>
        </UL>
        <P>
          The result is a payment experience with the complexity of a trading desk and the
          confidence of a guess.
        </P>
      </DocSection>

      <DocSection id="approach" title="3. Intent Pay's Approach">
        <P>
          Intent Pay inverts the flow. Instead of asking the user to construct a transaction, it asks
          what the user wants to happen and then does the engineering. Concretely:
        </P>
        <OL>
          <LI>
            <strong className="text-white/80">Capture the intent.</strong> The user states a
            recipient, an amount, and the asset the recipient should receive — by form or in plain
            English.
          </LI>
          <LI>
            <strong className="text-white/80">Resolve reality.</strong> The app reads the wallet&apos;s
            real balances, prices the assets, and finds executable routes from the assets the user
            holds to the asset the recipient wants.
          </LI>
          <LI>
            <strong className="text-white/80">Choose the source deterministically.</strong> A
            deterministic engine picks the asset to spend, with a human-readable reason, and refuses
            when nothing is executable.
          </LI>
          <LI>
            <strong className="text-white/80">Prepare one protected transaction.</strong> The plan is
            constructed with an on-chain minimum output (or maximum input) so the recipient cannot be
            short-changed.
          </LI>
          <LI>
            <strong className="text-white/80">Review and authorize.</strong> The user sees the key
            numbers, expands advanced details only if they want to, and signs.
          </LI>
          <LI>
            <strong className="text-white/80">Verify delivery.</strong> After confirmation, the app
            proves the recipient&apos;s on-chain transfer against the bound the transaction enforced.
          </LI>
        </OL>
        <P>
          The guiding constraint is honesty. A feature is described as operational only when it has
          been implemented and, where the repository can demonstrate it, verified. Everything else is
          labelled as in progress or planned.
        </P>
      </DocSection>

      <DocSection id="intent-driven" title="4. Intent-Driven Payments">
        <P>
          An intent is a statement of desired outcome, not a set of instructions. Intent Pay&apos;s intent
          captures:
        </P>
        <UL>
          <LI>the recipient address;</LI>
          <LI>the asset the recipient should receive;</LI>
          <LI>the amount, and whether it is expressed in dollars or in token units;</LI>
          <LI>whether the amount describes what the recipient receives or what the sender spends;</LI>
          <LI>an optional explicit source asset, when the user genuinely chooses to spend a specific one.</LI>
        </UL>
        <P>
          The canonical intent is a single source of truth shared by the chat interface, the payment
          composer, the quote, the plan and the signing guard. There is no second copy of payment
          state, so the &ldquo;top says one thing, composer says another&rdquo; class of bug is structurally
          prevented.
        </P>
        <P>
          Natural language is an additional interface, not a second payment system. A deterministic,
          offline parser is the authority: it must work with no AI provider configured, and it
          distinguishes the three amount forms on purpose —
        </P>
        <UL>
          <LI><Code>$10</Code> → a dollar value, no asset chosen;</LI>
          <LI><Code>10 MON</Code> → a token quantity of MON the recipient should receive;</LI>
          <LI><Code>$10 worth of MON</Code> → a dollar value denominated in MON.</LI>
        </UL>
        <P>
          An optional language model may only fill gaps the rules missed. It can never supply a
          price, a route, an address or a transaction, and its output is sanitized so unknown keys,
          addresses and prices are dropped. A name is never turned into an address: the address is
          only ever an explicit, validated <Code>0x…</Code> value. When a critical field is missing,
          the engine asks one concise question at a time.
        </P>
      </DocSection>

      <DocSection id="ux" title="5. User Experience">
        <P>
          The user journey is intentionally short and Web2-shaped:
        </P>
        <OL>
          <LI>Connect a wallet.</LI>
          <LI>Enter a payment request (form or natural language).</LI>
          <LI>Review the interpreted request — recipient, asset, amount.</LI>
          <LI>Confirm the recipient and amounts, and see the network fee.</LI>
          <LI>Review the applicable route summary and any warnings.</LI>
          <LI>Confirm and send.</LI>
          <LI>Follow the real transaction status, ending in verified delivery.</LI>
        </OL>
        <P>
          Amounts are shown USD-first, with token amounts as secondary detail. The primary review
          shows only what a person needs to decide safely: recipient, what they receive, what the
          sender spends, the estimated network fee, any applicable fee, the exchange rate where a
          conversion occurs, and slippage or price-impact warnings. Advanced routing information —
          pools, fee tiers, intermediate tokens, the exact route — lives in an optional expandable
          section. Material fees and risks are never hidden behind that section.
        </P>
        <P>
          The experience preserves the user&apos;s intent across recoverable errors. A moved price, a
          drained balance or an account switch produces a specific message and a retry, not a forced
          restart. Loading states are explicit while balances, prices and quotes are fetched, and
          duplicate submissions are prevented.
        </P>
      </DocSection>

      <DocSection id="architecture" title="6. Technical Architecture">
        <P>
          The system is layered so each concern can be reasoned about and tested in isolation. Layers
          are pure where possible; network access is confined to the server or the wallet client.
        </P>
        <UL>
          <LI>
            <strong className="text-white/80">Intent layer</strong> — <Code>lib/domain/intent.ts</Code>,{" "}
            <Code>lib/domain/validation.ts</Code>, <Code>lib/domain/canonicalIntent.ts</Code>. Defines
            the payment intent, its validation, and the single canonical state.
          </LI>
          <LI>
            <strong className="text-white/80">Natural-language layer</strong> — <Code>lib/nlp/*</Code>. A
            deterministic parser, a state machine derived only from the structured draft, a question
            generator, an optional gap-filling LLM, and a handoff to the composer.
          </LI>
          <LI>
            <strong className="text-white/80">Wallet / balances layer</strong> —{" "}
            <Code>lib/hooks/useWallet.ts</Code>, <Code>app/api/balances/route.ts</Code>. Reads the
            connected account and its real, on-chain-confirmed balances.
          </LI>
          <LI>
            <strong className="text-white/80">Quote / routing layer</strong> — <Code>lib/providers/*</Code>,{" "}
            <Code>lib/server/quote.ts</Code>. Behind one interface (<Code>getRoutingProvider</Code>),
            a demo provider and the live Uniswap V3 provider. The UI never branches on which is active
            beyond the demo/live label.
          </LI>
          <LI>
            <strong className="text-white/80">Construction layer</strong> — <Code>lib/execution/plan.ts</Code>,{" "}
            <Code>lib/execution/abis.ts</Code>. Turns a quote into explicit steps carrying real
            on-chain bounds.
          </LI>
          <LI>
            <strong className="text-white/80">Execution layer</strong> — <Code>lib/execution/execute.ts</Code>.
            Submits the plan through the user&apos;s wallet and tracks step results.
          </LI>
          <LI>
            <strong className="text-white/80">Verification layer</strong> — <Code>lib/execution/verify.ts</Code>.
            Proves the recipient&apos;s on-chain transfer from the confirmed receipt.
          </LI>
          <LI>
            <strong className="text-white/80">Signing guard</strong> — <Code>lib/execution/signGuard.ts</Code>.
            The only path to a signature; re-validates everything from fresh data immediately before
            signing.
          </LI>
        </UL>
        <P>
          Tokens, chains and Uniswap deployments are configuration-driven
          (<Code>lib/config/tokens.ts</Code>, <Code>lib/config/chains.ts</Code>,{" "}
          <Code>lib/providers/constants.ts</Code>). No component or route hardcodes a token symbol.
        </P>
      </DocSection>

      <DocSection id="monad" title="7. Monad Integration">
        <P>
          Monad is the target network. Intent Pay is configured for Monad mainnet, chain id 143, and
          reads and writes real chain state through an RPC transport (an Alchemy Monad endpoint when a
          key is configured, otherwise the public Monad RPC).
        </P>
        <P>
          Monad-specific properties the implementation accounts for:
        </P>
        <UL>
          <LI>
            <strong className="text-white/80">Fast finality.</strong> Monad reaches full finality after
            two blocks. Execution waits for full finality before verifying delivery, so the receipt it
            verifies from cannot be reorged.
          </LI>
          <LI>
            <strong className="text-white/80">Deployed router shape.</strong> The Monad deployment of
            Uniswap SwapRouter02 exposes the deadline-less selectors — it has no{" "}
            <Code>deadline</Code> parameter. The implementation does not add one, because doing so
            changes the function selector and the call would revert. Quote freshness is enforced
            off-chain instead.
          </LI>
          <LI>
            <strong className="text-white/80">No live private order flow.</strong> Monad has no
            globally available private mempool and no dapp-controllable private submission path. MEV
            protection is therefore reported as unavailable, and the app relies on on-chain slippage
            bounds, a price-impact guard and delivery verification instead of a cosmetic badge.
          </LI>
        </UL>
        <Callout tone="warn" title="Cross-chain is out of scope">
          Intent Pay moves value between assets <em>on Monad</em>. It is not a bridge and does not
          claim cross-chain delivery. A payment whose receive asset has no Monad liquidity cannot be
          completed, and the app says so rather than implying otherwise.
        </Callout>
      </DocSection>

      <DocSection id="tokens" title="8. Token Discovery and Routing">
        <P>
          Token usability is modelled as a sequence of honest states rather than a boolean. A token
          that merely resolves is not presented as payable:
        </P>
        <UL>
          <LI><Code>UNKNOWN</Code> — could not be identified (no contract code, bad address).</LI>
          <LI><Code>DISCOVERED</Code> — the contract exists and metadata resolved.</LI>
          <LI><Code>PRICE_AVAILABLE</Code> / <Code>PRICE_UNAVAILABLE</Code> — a trustworthy USD price exists, or it does not (never shown as $0.00).</LI>
          <LI><Code>ROUTE_AVAILABLE</Code> / <Code>ROUTE_UNAVAILABLE</Code> — a real route was probed and exists, or does not.</LI>
          <LI><Code>PAYABLE</Code> — discovered, priced <em>and</em> routable.</LI>
        </UL>
        <P>
          A user can search by symbol, name, or contract address. An address is validated, its
          contract code is verified on Monad mainnet, and its metadata (<Code>decimals</Code>,{" "}
          <Code>symbol</Code>) is re-read from the contract before it can be spent. External metadata
          is never authoritative over what the contract reports. Two tokens sharing a symbol are kept
          distinct, and a name is only resolved when it maps unambiguously to a ticker.
        </P>
        <P>
          Discoverability and executability are separate. A discovered token may support a direct
          transfer while having no swap route; in that case a direct transfer is allowed and a
          conversion is refused with a clear explanation. A direct transfer is never presented as a
          swap, and a swap is never presented as a direct transfer.
        </P>
        <P>
          Routing uses live Uniswap V3 pools on Monad. The router supports exact-output and
          exact-input modes, discovers pools across fee tiers, and evaluates multi-hop candidates
          through basis tokens (including the native MON, pooled as WMON). The route chosen is the
          best available among the quotes actually evaluated — the app does not claim it is the
          globally optimal route. Selection weighs expected output, network cost, price impact,
          slippage and execution feasibility, and prefers the best net outcome rather than the largest
          gross number before fees.
        </P>
        <P>
          Tokens are also assessed for execution risk using measurable facts — pool liquidity, a real
          transfer simulation, a live quote, and the route&apos;s price impact. A fact that could not be
          measured is reported as unknown, never as a failure, so a transient RPC error cannot present
          itself as a bad token.
        </P>
      </DocSection>

      <DocSection id="execution" title="9. Transaction Execution">
        <P>
          Execution is the standard path through the user&apos;s own injected wallet (an externally owned
          account). The flow is:
        </P>
        <OL>
          <LI>Detect the connected wallet and the active network.</LI>
          <LI>Confirm the wallet is on Monad mainnet.</LI>
          <LI>Read the actual token balances.</LI>
          <LI>Prepare the proposed transaction(s).</LI>
          <LI>Estimate gas.</LI>
          <LI>Display the required payment and network-fee information.</LI>
          <LI>Validate recipient, token, amount and transaction details.</LI>
          <LI>Request authorization from the wallet.</LI>
          <LI>Submit through the supported wallet flow.</LI>
          <LI>Verify the actual transaction receipt.</LI>
          <LI>Show success only after successful execution is confirmed.</LI>
        </OL>
        <P>
          A payment is a single prepared transaction for a normal swap-or-transfer, or two protected
          legs when the user holds part of a requested token quantity and another funded asset covers
          the shortfall. Each swap leg carries its own on-chain bound.
        </P>
        <P>
          Signing is gated by the signing guard, which is the only path to a signature. Immediately
          before signing it fetches fresh balances and a fresh quote, re-reads the canonical intent
          and the wallet account, re-checks freshness, price impact and balance/gas coverage, rebuilds
          the calldata from the fresh quote, and asserts the output bound. Any change aborts with a
          specific reason; calldata is never reused from an earlier build.
        </P>
        <P>
          After confirmation, delivery is verified from the receipt against the minimum the
          transaction enforced. A reverted transaction is failed; an unprovable delivery is shown as
          unverified, never as success. The interface does not claim success merely because a wallet
          prompt closed, and it never automatically resubmits a transaction that may already have been
          broadcast.
        </P>
      </DocSection>

      <DocSection id="gas" title="10. Gas Handling and Fees">
        <P>
          Gas is always paid in native MON by the user&apos;s own wallet. There is no sponsored,
          ERC-20, or account-abstracted gas path in this application. An earlier EIP-7702 /
          paymaster-based ERC-20 gas experiment was removed because it could not be demonstrated to
          complete a real end-to-end payment with the target wallets on Monad.
        </P>
        <Callout tone="warn" title="Not gasless">
          Intent Pay is not a gasless product. If a wallet holds no MON to cover the network fee, the
          payment cannot proceed and the app says so explicitly before execution rather than implying
          that gas will be covered another way.
        </Callout>
        <P>
          The review screen separates, where each is available:
        </P>
        <UL>
          <LI>the amount delivered to the recipient;</LI>
          <LI>the amount spent by the sender;</LI>
          <LI>the swap or protocol fee embedded in the route (if any);</LI>
          <LI>the estimated network gas cost.</LI>
        </UL>
        <P>
          Intent Pay does not currently charge a service fee, and does not claim a guaranteed profit
          or that any fee would cover gas. Service-fee collection is a planned capability, not an
          operational one, and would be displayed before authorization if it were added.
        </P>
      </DocSection>

      <DocSection id="security" title="11. Security and User Control">
        <P>
          The security model is that the transaction, not the interface, enforces the outcome. The
          product goal — an attacker cannot make the recipient receive drastically less while the app
          still reports success — is met by the following measures.
        </P>
        <UL>
          <LI>
            <strong className="text-white/80">On-chain output bound.</strong> Every swap step carries a
            real <Code>amountOutMinimum</Code> (exact-input) or <Code>amountInMaximum</Code>{" "}
            (exact-output), derived from a clamped slippage tolerance (default 0.5%, hard ceiling 5%).
            The signing guard refuses to sign a swap without a bound. The UI&apos;s &ldquo;minimum
            received&rdquo; figure is never the protection — the calldata is.
          </LI>
          <LI>
            <strong className="text-white/80">Price-impact guard.</strong> A route whose live price
            impact exceeds the configured ceiling (default 3%) is blocked before signing. Slippage is
            never widened to rescue a bad route; an unmeasurable impact does not fabricate a number.
          </LI>
          <LI>
            <strong className="text-white/80">Quote freshness.</strong> A quote is a live, perishable
            value (hard limit 20 seconds). A stale quote disables confirmation and is refreshed; a
            failed refresh keeps a last-known-good quote while it is still usable, so a transient
            provider error does not destroy the payment, and a definitive failure clears it honestly.
          </LI>
          <LI>
            <strong className="text-white/80">Signing-time re-validation.</strong> The guard rebuilds
            everything from fresh data immediately before the wallet is asked to sign, and re-reads
            the intent a final time so a change during preparation aborts.
          </LI>
          <LI>
            <strong className="text-white/80">Delivery verification.</strong> Success is reported only
            after the recipient&apos;s transfer is proven from the confirmed receipt against the
            enforced minimum.
          </LI>
          <LI>
            <strong className="text-white/80">No fabricated state.</strong> The app never manufactures
            a quote, a liquidity figure, a price or a transaction hash. Demo mode is labelled and never
            produces a hash.
          </LI>
        </UL>
        <P>
          The user remains in control throughout: the wallet authorizes every transaction, the app
          never holds a key or a seed phrase, and no transaction is signed without the user&apos;s explicit
          approval of the exact prepared details.
        </P>
      </DocSection>

      <DocSection id="capabilities" title="12. Current Capabilities and Limitations">
        <P>
          This section separates what is verified, what is implemented but unverified, what is in
          progress, and what is planned. It reflects the repository, not an aspiration.
        </P>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="card-flat p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-300/80">
              Verified / covered by tests
            </div>
            <UL>
              <LI>Deterministic intent parsing and validation (dollar, token, and &ldquo;worth of&rdquo; forms).</LI>
              <LI>Intent state machine and single canonical intent.</LI>
              <LI>Quote freshness and refresh-resilience rules.</LI>
              <LI>Deterministic source selection with explicit failure codes.</LI>
              <LI>Token-state and token-risk classification.</LI>
              <LI>Plan construction with on-chain bounds.</LI>
              <LI>Signing guard abort reasons.</LI>
              <LI>Delivery verification from a receipt.</LI>
              <LI>Partial-balance split arithmetic (scaled-integer).</LI>
            </UL>
          </div>
          <div className="card-flat p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-300/80">
              Implemented — needs live confirmation
            </div>
            <UL>
              <LI>Live Uniswap V3 routing against real Monad pools (opt-in live tests).</LI>
              <LI>End-to-end execution and delivery verification with a real wallet (no automated test can sign for a user).</LI>
              <LI>Live price providers, whose availability depends on configuration and network.</LI>
            </UL>
          </div>
        </div>
        <P>
          <strong className="text-white/80">Limitations.</strong> Gas is not abstracted. Cross-chain
          delivery is not supported. A route must exist and have liquidity; a token can be discovered
          without being tradable. MEV-protected submission is unavailable on Monad. A private
          submission endpoint cannot be forced onto an injected wallet, so the app does not fake an
          &ldquo;active&rdquo; badge.
        </P>
        <P>
          <strong className="text-white/80">In progress / planned.</strong> A service fee and its
          on-screen disclosure; broader live-network verification; and further UX refinement are
          planned (see section 13). None of these are presented as operational today.
        </P>
      </DocSection>

      <DocSection id="roadmap" title="13. Development Roadmap">
        <P>
          The roadmap distinguishes work that is done from work that is planned. Dates are not
          promised here.
        </P>
        <UL>
          <LI>
            <strong className="text-white/80">Built.</strong> Intent model and canonical state;
            deterministic natural-language parsing; live Uniswap V3 routing and quoting; token
            discovery by symbol/name/address; token state and risk models; deterministic source
            selection; partial-balance split; protected plan construction; signing guard; delivery
            verification; the payment composer and review flow.
          </LI>
          <LI>
            <strong className="text-white/80">In progress.</strong> Expanding live-network verification
            coverage; refining copy and error surfaces; and hardening mobile layouts.
          </LI>
          <LI>
            <strong className="text-white/80">Planned.</strong> Transparent service-fee collection and
            disclosure; richer route comparison where more quote sources become available; and
            continued accessibility work.
          </LI>
          <LI>
            <strong className="text-white/80">Explicitly out of scope.</strong> Reintroducing
            speculative gas-abstraction paths that cannot be demonstrated end-to-end.
          </LI>
        </UL>
      </DocSection>

      <DocSection id="use-cases" title="14. Potential Use Cases">
        <UL>
          <LI>
            <strong className="text-white/80">Paying a vendor who invoices in a stablecoin</strong>{" "}
            while holding a different asset.
          </LI>
          <LI>
            <strong className="text-white/80">Sending a fixed value</strong> where the sender holds
            several assets and wants the best available one to be chosen automatically.
          </LI>
          <LI>
            <strong className="text-white/80">Paying a specific token quantity</strong> (for example,
            &ldquo;send 100 NEWCOIN&rdquo;) where the wallet holds part of it and another asset covers the
            shortfall.
          </LI>
          <LI>
            <strong className="text-white/80">Treasury-style outflows</strong> where predictable,
            reviewable transaction preparation and receipt verification matter more than trading.
          </LI>
          <LI>
            <strong className="text-white/80">Any payment where the recipient&apos;s need should be
            authoritative</strong> and the sender&apos;s asset choice should be the app&apos;s problem.
          </LI>
        </UL>
        <P>
          These describe intended uses of the implemented capability. They are not claims about
          liquidity, safety, or commercial adoption of any particular token or counterparty.
        </P>
      </DocSection>

      <DocSection id="faq" title="15. Frequently Asked Questions">
        <P><strong className="text-white/80">Is Intent Pay a DEX or a swap interface?</strong> No. It is a payment application. Routing is machinery underneath; the user reviews and authorizes a payment.</P>
        <P><strong className="text-white/80">Can I pay with any token?</strong> Any compatible token on Monad can be discovered and used when the wallet balance and a real execution path support the operation. A discovered token with no liquidity cannot be converted; a direct transfer may still work.</P>
        <P><strong className="text-white/80">Do I need MON for gas?</strong> Yes. Gas is always paid in native MON by your wallet. There is no gasless or ERC-20 gas option.</P>
        <P><strong className="text-white/80">Does Intent Pay charge a fee?</strong> No service fee is currently charged. Service-fee collection is planned and would be shown before authorization.</P>
        <P><strong className="text-white/80">Can it send to another chain?</strong> No. Intent Pay is Monad-only. It is not a bridge.</P>
        <P><strong className="text-white/80">How do I know the recipient got the funds?</strong> After the transaction confirms, the app verifies the recipient&apos;s transfer from the receipt against the on-chain minimum the transaction enforced.</P>
        <P><strong className="text-white/80">Does the AI move my money?</strong> No. The deterministic engine and the signing guard govern execution. The AI only interprets a sentence, and can never supply a price, route, address or transaction.</P>
        <P><strong className="text-white/80">Is the best route guaranteed?</strong> No. The app selects the best available route among the quotes it evaluated and says so.</P>
      </DocSection>

      <DocSection id="conclusion" title="16. Conclusion">
        <P>
          Intent Pay demonstrates that an onchain payment can be as simple as a Web2 payment in the
          way it is described and reviewed, while remaining ruthlessly honest about what happens
          underneath. The hard part is not the interface; it is wiring real balances, real prices,
          real routes, real bounds and real receipt verification into a flow that never fabricates a
          result and never overstate a capability.
        </P>
        <P>
          The current implementation delivers intent-driven payments on Monad with deterministic
          validation, protected execution, verified delivery, dynamic token discovery and honest
          failure. Gas is paid in MON; cross-chain delivery is out of scope; and features that are not
          finished are documented as such rather than implied to work.
        </P>
      </DocSection>
    </DocsShell>
  );
}
