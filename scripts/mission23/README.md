# Mission 23 — Trust Wallet RPC failure + blank wallet picker

Manual harnesses used to root-cause and verify the two reported defects against
the real app and the real Trust Wallet provider bundle (not mocks). They are not
part of the test suite or the build. The durable results are pinned as
regressions in `tests/`; these scripts are the reproduction that produced them.

Requirements: Chromium at `/usr/bin/chromium` (or set `CHROMIUM`) and a local
`playwright` (resolved from the npx cache). Some Trust-bundle probes need the
vendor bundle at `/tmp/trust_min.js` (or set `TRUST_MIN`); fetch it from
`github.com/trustwallet/trust-web3-provider` (`trust_min.js`). Run with
`node scripts/mission23/<name>.mjs [base-url] [args]`.

| Script | What it proves |
| --- | --- |
| `rpcStallProbe.mjs` | The production outage: a preferred RPC endpoint that accepts the connection but never replies. Starts a blackhole server, points `MONAD_RPC_URL` at it, and times `/api/tokens`, `/api/balances`, `/api/quote`. Pre-fix each route paid the endpoint timeout (>=20 s) and exceeded the serverless limit; post-fix every route answers in ~1–2 s from the public Monad RPC. |
| `modalGeometry.mjs` | The blank wallet picker. Drives the real app on a 430×940 viewport and prints the modal overlay/dialog geometry. Pre-fix the overlay was sized to the sticky header (`overlayH` ≈ 68) and the picker row sat off-screen (`rowY` < 0); post-fix `overlayH` equals the viewport and the row is on screen. |
| `connectMatrix.mjs` | Injects several provider shapes (EIP-6963, legacy-only, Trust flags, late injection) and records discovery, label, duplication and one-click connect. |
| `composerConfirmFlow.mjs` | Drives the real composer to Confirm with a funded wallet and a routable intent, to reproduce a "Confirm → back to composer" loop or blank. |
| `checkoutFailureModes.mjs` | Drives the real `/checkout/:token` page (token passed as arg 3) through wallet-reject and unmined-hash, asserting the page never blanks. |
| `checkoutPayFlow.mjs` | Drives the real checkout through "Pay $X" with a real mined hash (`REAL_HASH`) or a never-mined one. |
| `checkoutTrustFlow.mjs` | Drives the real checkout with the real Trust provider bundle. |
| `realTrustProviderProbe.mjs` | Loads the real Trust bundle and records, per method, whether it answers natively or proxies to `monad.twnodes.com`. Evidence about the *wallet*, not the app. |
| `realTrustViemProbe.mjs` | With the real Trust bundle, records which viem wallet-client surfaces call through the wallet and which of those are proxied. |
| `realTrustFlow.mjs` | Drives the real Trust bundle through the app's full payment flow, recording every proxied read. |
| `trustFullPath.mjs` | Drives the real Trust bundle through the full composer flow with a funded address. No signature, approval or transaction: the native adapter answers `eth_sendTransaction` with a stub hash. |
