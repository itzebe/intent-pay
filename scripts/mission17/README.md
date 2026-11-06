# Mission 17 reproduction harness

These are **manual** Playwright harnesses used to reproduce and verify the two
defects on the real deployed app (not mocks). They are not part of the test
suite or the build.

Requirements: `npx playwright install chromium` (Playwright is not a declared
dependency; the scripts resolve it from the local/npx cache).

## Defect A — late mobile wallet injection

Injects a Trust-Wallet-style legacy-only provider (`window.ethereum` +
`window.trustwallet.ethereum`, no EIP-6963, no `ethereum#initialized`) after a
delay, then opens the wallet picker and reports whether the wallet is offered.

```bash
node scripts/mission17/reproWallet.mjs https://intent-pay-roan.vercel.app 9000
```

A delay past the discovery window (the Android report was ~9 s) is the bug: on
the pre-fix build the picker says "No browser wallet detected" until the manual
Rescan; on the fixed build Trust Wallet is listed immediately.

## Defect B — transient quote outage

Reaches Review through the real UI (real balances, real quote), then proxies
`/api/quote` and injects a failure window for the configured duration, recording
the Review state every few seconds.

```bash
# Transient outage: the held quote must survive and recover.
FAIL_FROM_MS=1000 FAIL_TO_MS=32000 FAIL_MODE=provider_error \
  node scripts/mission17/repro.mjs http://localhost:3000 /tmp/mission17fault

# Definitive outage: the honest "no route" state is expected.
FAIL_FROM_MS=1000 FAIL_TO_MS=32000 FAIL_MODE=route_unavailable \
  node scripts/mission17/repro.mjs http://localhost:3000 /tmp/mission17ra
```

Reports are written to the given output directory as `report.json`.

## Defect: direct injected-wallet connect (Mission 18)

Injects a Trust-Wallet-style provider whose account methods are answered locally
but whose **chain reads are proxied to `https://monad.twnodes.com`** from the
page context — exactly how the Android in-app browser behaves. Reports whether a
page-context fetch to that origin is allowed by the deployed CSP and whether the
wallet connects.

```bash
node scripts/mission17/reproConnect.mjs https://intent-pay-roan.vercel.app /tmp/m18
```

On the pre-fix build (`connect-src` without the wallet's origin) the probe is
`error: TypeError: Failed to fetch` and `connectedAddressShown` is false; after
the fix both are healthy. The harness uses no application mocks — only the
wallet is stubbed.

## Defect: Continue Payment does not blank the checkout (Mission 18)

Drives the real deployed composer with a stub EIP-6963 wallet: connects, fills
recipient + amount (every balances/quote/optimize call is live), then activates
the composer's own CTA and asserts the page is not blank and no page error was
thrown. An unfunded wallet is expected to be blocked *honestly* ("No executable
payment asset"), never with a blank screen.

```bash
node scripts/mission17/reproComposer.mjs https://intent-pay-roan.vercel.app
```
