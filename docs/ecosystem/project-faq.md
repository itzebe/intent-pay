# Intent Pay — FAQ (ecosystem)

Direct answers. Where something is not available, it is said plainly.

## Networks

**Which networks are supported?** Monad Mainnet only, chain id 143. There is no
testnet or fallback network in the product.

## Tokens

**Which tokens are supported?** A shipped set (MON, USDC, USDT, WETH, AUSD, SOL)
plus any token discovered live from real Monad chain state — resolution is by
symbol, name or contract address, not a fixed allow-list. A token is only
"payable" once it has a trustworthy price and a real route
(`lib/domain/tokenState.ts`).

## Wallet compatibility

**Which wallets work?** Any EIP-6963 injected wallet (MetaMask, Rabby, Coinbase
and others) via discovery with a legacy `window.ethereum` fallback, plus
WalletConnect (mobile/QR) when configured.

## Security

**How is security enforced?** A signing guard rebuilds the transaction from fresh
data immediately before signing and refuses on any change; every swap carries a
real on-chain output bound; a price-impact guard blocks a bad route; a
submission is never retried.

## Custody

**Does Intent Pay hold funds?** No. It is non-custodial. No private key or seed
phrase is ever requested or held, and no custody exists anywhere in the API.

## Transaction authorization

**Who signs?** The user, in their own wallet. A credential can prepare a
transaction but can never sign or send one.

## Settlement verification

**How do you know a payment succeeded?** Only from a confirmed on-chain receipt:
`verifyDelivery` proves the recipient's actual transfer against the minimum the
transaction enforced. A reverted transaction is failed; an unprovable delivery
is unverified — never success.

## API credentials

**How do I get an API key?** Production credentials are provisioned by the
operator today; there is no self-service signup yet. The key authorizes API
calls only — it cannot sign or move funds.

## Webhooks

**Are webhooks available?** Yes, with HMAC-SHA256 signatures. Delivery is
request-driven; a production merchant should add a scheduled drain.

## SDK availability

**Is there an SDK?** Yes — `@intentpay/sdk`, TypeScript, built from this
repository. It is **not yet on npm** (the npm scope is not held by the owner);
install from the built tarball until it is published.

## Sandbox availability

**Is there a sandbox or testnet?** No. There is no simulated ledger and no
testnet. A `test` API key does not change the chain. Development exercises real
mainnet value.

## Refund limitations

**Can a payment be refunded?** No refund endpoint exists. An overpayment is not
refunded automatically and must be reconciled manually.

## Ecosystem relationship

**Is Intent Pay affiliated with Monad?** No. It is independent infrastructure
built on Monad. No partnership, sponsorship or endorsement by the Monad
Foundation is claimed.
