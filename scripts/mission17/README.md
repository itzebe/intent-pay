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
