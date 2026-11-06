# Mission 22 — Trust Wallet RPC independence

Manual Playwright harnesses used to reproduce and verify the reported
`Failed to connect to http://monad.twnodes.com/` failure on the real deployed
app (not mocks). They are not part of the test suite or the build.

Requirements: Chromium at `/usr/bin/chromium` (or set `CHROMIUM`) and a local
`playwright` (resolved from the npx cache). Run with
`node scripts/mission22/<name>.mjs [base-url]`.

| Script | What it proves |
| --- | --- |
| `trustProbe.mjs` | A Trust-faithful injected provider (native account/chain/send, everything else proxied to `http://monad.twnodes.com`) records every method the app requests. Establishes that connect issues no proxied read, so the failure is at send time. |
| `trustPaymentFlow.mjs` | Drives the real composer with that provider, whose own `eth_chainId` read fails (`TypeError: Failed to fetch`). Asserts the wallet still connects and the app never surfaces the raw RPC error. |

The durable result is pinned as a regression in
`tests/walletRpcIndependence.test.ts`: viem's high-level `writeContract` reads
`eth_chainId` through the wallet and aborts before sending, while the app's
provider-agnostic `eth_sendTransaction` submission never asks the wallet for a
chain read. The SDK equivalent lives in `packages/sdk/test/wallet.test.ts`.
