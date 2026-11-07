# Mission 24 — Trust Wallet "confirm and send" RPC failure

Reproduction harness for the reported failure: Intent Pay opens in Trust Wallet,
the wallet connects, and Confirm and Send fails with
`Failed to connect to http://monad.twnodes.com/`.

## `trustSendFields.mjs`

Loads the **real** Trust Wallet provider bundle (`dist/trust-min.js`) into a
headless Chromium page, constructs its provider with Trust's own Monad RPC
(`http://monad.twnodes.com/`), spies on the native bridge
(`window.trustwallet.postMessage`), and makes every page-world `fetch` to that
host fail — exactly a device where the host is unreachable.

It then issues two otherwise identical `eth_sendTransaction` requests:

| Case | Fields supplied |
| --- | --- |
| `prepared` | `gas` + `maxFeePerGas` + `maxPriorityFeePerGas` |
| `omitted` | only `from`/`to`/`value`/`chainId` |

and records, per case, the object forwarded to the native bridge, the provider
methods requested, any proxied reads, and the outcome.

```bash
TRUST_MIN=/path/to/trust_min.js node scripts/mission24/trustSendFields.mjs
```

### Result (evidence)

Both cases returned the hash, requested only `eth_sendTransaction`, and made
**zero** proxied reads to the Trust RPC. The provider forwards `params[0]`
verbatim to the native bridge either way (`src/ethereum_provider.js`:
`postMessage("signTransaction", payload.id, payload.params[0])`).

This proves the `monad.twnodes.com` connection error does **not** originate in
the JS provider for `eth_sendTransaction` — it is raised inside Trust Wallet's
closed-source native layer, which the dApp cannot inspect or configure. The app's
defensible fix is therefore to remove every *pre-signing* read the wallet would
otherwise have to make, by preparing `gas`/fees/nonce through Intent Pay's own
RPC (`lib/execution/prepareTx.ts`).

A physical Android Trust Wallet is the only way to confirm the native broadcast
step itself.
