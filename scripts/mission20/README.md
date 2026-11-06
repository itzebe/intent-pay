# Mission 20 — production wallet/RPC forensics (read-only probes)

These scripts are **diagnostic only**. They make no state change and never sign
or submit anything. They were used to establish, against production, the exact
boundary between Intent Pay's *own* RPC clients and the wallet provider's own
network reads.

Run with `node scripts/mission20/<name>.mjs [base-url]` (defaults to
`https://intent-pay-roan.vercel.app`). Chromium is expected at `/usr/bin/chromium`.

| Script | What it proves |
| --- | --- |
| `cspProbe.mjs` | Which RPC origins the production CSP lets the page reach (`https://monad.twnodes.com` allowed; `http://monad.twnodes.com` blocked with an explicit `connect-src` violation). |
| `appRpcProbe.mjs` | The app's own endpoints (`rpc.monad.xyz`, the keyed Alchemy host) answer from the page context — so a blocked wallet origin is not our client. |
| `trustRealProbe.mjs` | The real Trust Wallet in-app-browser provider shapes (iOS proxy + factory, Android provider/factory) connect with the documented behaviour. |
| `discoveryMatrix.mjs` | Every documented Trust shape — including injected ~9 s late — is discovered and listed. |
| `viemMethods.mjs` | The JSON-RPC methods viem actually sends through the wallet during `writeContract`/`sendTransaction`: only `eth_chainId` + `eth_sendTransaction`. Every other read is made by our own client. |

The last one is the durable result: the app never asks the wallet for gas, nonce,
balance or a receipt, which is what makes an application-owned RPC recovery
possible. It is pinned as a regression in `tests/appOwnedRpc.test.ts`.
