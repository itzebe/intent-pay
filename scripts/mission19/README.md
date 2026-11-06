# Mission 19 — reproduction harnesses

Diagnostic Playwright harnesses for the two production defects fixed in this
mission. They drive the **real deployed UI** against a **stubbed wallet** — no
signature, no approval and no real transaction is ever created. They are manual
tools, not part of `npm test`.

## Defect A — a wallet listed twice in the picker

A wallet present on `window.ethereum` **before** the app boots (the common
desktop case, and any in-app browser that injects early) is read from the legacy
slot and then answers `eip6963:requestProvider` with the **same provider
object**. The picker listed it twice because de-duplication was by EIP-6963 uuid
only, and the legacy entry has a different id.

- `dupProbe.mjs <url>` — one legacy-first provider that also announces. Pre-fix:
  `rows: 2`; post-fix: `rows: 1`.
- `lateInjectMatrix.mjs <url> [injectMs]` — the late-injection shapes a Trust
  Wallet in-app browser may use (`ethereum`, `trust-only`, `trust-then-eth`,
  `trust-announce`). Confirms late injection keeps working after the fix.

## Defect B — the payment hangs on the first receipt read

`waitForTransactionReceipt` reads `eth_getTransactionReceipt` through viem
`fallback`. `fallback` only tries the next endpoint when a call **throws**; a
node that answers `null` (healthy, but has not indexed the receipt yet) is a
successful call, so every other endpoint is skipped and the wait spins until its
90 s timeout. The composer stayed on "Wrap MON for the route" after the wallet
had actually wrapped; the checkout stayed on "confirming on-chain" forever.

- `fullExecB.mjs <url> [outDir]` — drives the composer to Review and presses
  Confirm with a stubbed wallet. `FAKE_HASH=0x…` (a hash that will never be
  mined) reproduces the hang: `waiting: true` for the full window, then the
  `UnresolvedPanel`. Without `FAKE_HASH` it uses a real mined hash and reaches
  the success path. Deterministic regression coverage lives in
  `tests/receiptFailover.test.ts`.
- `checkoutFlow.mjs <url> <token> [outDir]` — drives the hosted customer page
  through "Pay $X" with a stub wallet returning a real mined hash.

## Running

```bash
CHROMIUM=/usr/bin/chromium node scripts/mission19/dupProbe.mjs https://intent-pay-roan.vercel.app
```

`fullExecB.mjs` and `checkoutFlow.mjs` need a funded intent; the other probes
only need a page.
