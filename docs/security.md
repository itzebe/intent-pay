# Security

## Non-custodial principles

Intent Pay never holds a key, a seed phrase or a private key. It never asks for
one, and no code path accepts one. Authorization always happens in the user's own
wallet. If a screen or a message ever asks for a seed phrase or private key, it is
not Intent Pay.

## Wallet authorization

- The only path to a signature is `prepareSigning` (`lib/execution/signGuard.ts`).
- Immediately before signing it fetches **fresh** balances and a **fresh** quote,
  re-reads the canonical intent (version and key) and the wallet account,
  re-checks freshness, price impact, balance and gas coverage, rebuilds the
  calldata from the fresh quote, asserts the output bound, and re-reads the
  intent a final time.
- Any change aborts with a specific reason. Calldata is never reused from an
  earlier build.
- The guard refuses a payment the UI is not showing (`composer_mismatch`) unless
  the displayed fingerprint equals the canonical intent's.

## Transaction submission invariants

- **Exactly once.** A submission is sent exactly once and is **never retried**.
  viem's transport default is `retryCount: 3`, and it retries a transport-shaped
  failure — exactly the shape a wallet throws when it cannot reach its own node.
  Without an explicit `retryCount: 0`, the same `eth_sendTransaction` would be
  issued up to four times: the wallet would re-prompt and the payment could be
  broadcast more than once. Every viem wallet action that signs or submits passes
  `retryCount: 0`; `lib/wallet/sendTransaction.ts` does the same.
- **Sequential.** A multi-step plan (approve → swap → unwrap → deliver) sends one
  call, waits for its receipt, and only then sends the next. Broadcasting
  back-to-back lets a later call execute before its predecessor and revert.
- **On-chain bound.** Every swap step carries a real `amountOutMinimum`
  (exact-in) or `amountInMaximum` (exact-out), derived from a clamped slippage
  tolerance (default 50 bps, hard ceiling 500 bps). The UI's "Minimum received" is
  never the protection; the transaction is.
- **No fabricated deadline.** SwapRouter02 has no `deadline` parameter, so adding
  one changes the selector and reverts. Freshness is enforced off-chain by
  refusing a stale quote and rebuilding the calldata.

## Duplicate-submission protection

A single approval maps to a single broadcast. Two mechanisms enforce this:

- The transport-level `retryCount: 0` on the submission call (above).
- A durable claim of a transaction hash on `(chainId, txHash)` when settlement is
  proven for a checkout. A hash that already paid another order is refused with
  `409 replay_detected`.

## Ambiguous payment outcomes

A broadcast whose outcome is unknown is never reported as success. If a receipt
is not observed within the confirmation window, the step is reported with
`unconfirmed: true` and its hash is kept; `confirmed` becomes false and the
remaining steps are not run. The UI shows "Transaction status unknown" with the
hash(es) and a read-only status check — never the success screen — and nothing is
resubmitted automatically. `isAmbiguousSubmission(err)` marks the case that must
not be retried blindly.

## Authentication and authorization

- **Developer API.** Authenticated with a merchant API key
  (`Authorization: Bearer ipk_live_<prefix>.<secret>`). A key can build and
  verify, but can never authorize a payment.
- **Customer checkout routes.** Authenticated by the checkout token in the URL,
  not an API key. The page carries no credential.
- **Referral sessions.** A `personal_sign` prompt is only raised by an explicit
  user action; an existing session is adopted silently. Connecting a wallet does
  not raise a signature prompt.

## Secret handling

- No secret is committed to the repository; `.env.example` documents every key
  using placeholders only.
- **Email credentials are server-only.** `SMTP_PASS` (a Gmail App Password) and
  `RESEND_API_KEY` are read from the process environment, used only inside the
  server-side transport (`lib/developer/email.ts`), and never logged, returned in
  an API response, or embedded in a message. A delivery failure is reported as a
  fixed, credential-free sentence — the provider's own text (which can echo the
  host, the user name or a server reply) is never surfaced.
- The SMTP socket is always encrypted: implicit TLS on port 465, and a mandatory
  STARTTLS upgrade (`requireTLS`) on every other port, so the password never
  crosses a plaintext connection.
- The SDK refuses to construct a keyed client in a browser
  (`client_credential_in_browser`).
- A raw upstream error is never returned to a client: URLs are collapsed to their
  origin, messages are truncated to 200 characters, and no stack is returned.

## Known security limitations

- **MEV protection is not claimed.** Monad has no global mempool and no usable
  private submission path for an injected wallet, so `resolveMevProtection`
  returns `MEV_PROTECTION_UNAVAILABLE`. The review sheet shows "MEV Protection:
  Active" only when a private path really exists — never as a cosmetic badge.
- **Price impact** is blocked above a configured threshold
  (`NEXT_PUBLIC_MAX_PRICE_IMPACT_BPS`, default 3%). Slippage is never widened to
  rescue a bad route; an unmeasurable impact does not block.
- **Store durability** is a configuration fact, probed at runtime. Referral
  endpoints refuse with `503 storage_unavailable` rather than reporting an
  ephemeral success. Payment execution never depends on the store.
- **Live route coverage** for the long tail of tokens keeps expanding; an asset
  with no liquidity fails honestly.

## Responsible disclosure

Report a suspected vulnerability privately to the maintainers rather than opening
a public issue. Include the affected route or module, reproduction steps, and the
impact. Do not include seed phrases, private keys or live credentials in a report.
See the contact in [../README.md](../README.md).
