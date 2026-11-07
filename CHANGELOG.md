# Changelog

Notable technical milestones for Intent Pay. Entries reference the pull request
and merge commit where one exists. This project does not follow semantic
versioning yet; the list is chronological, newest first.

## 2026-11 — Payment acceptance and reliability

- **fix(wallet): never retry a transaction submission** — PR #49 (`a454a35`).
  A raw `eth_sendTransaction` inherited viem's transport default `retryCount: 3`,
  so a single approval could be submitted up to four times. Passing
  `{ retryCount: 0 }` restores exactly-once submission. This is the fix behind the
  owner-confirmed payment acceptance milestone.
- **fix(wallet): recover an unknown Trust Wallet outcome from on-chain evidence** —
  PR #48 (`af06fad`). An ambiguous submission outcome is resolved from on-chain
  evidence rather than a nonce.
- **fix(wallet): treat a post-authorisation transport failure as unknown** —
  PR #47 (`67952ae`).
- **fix(wallet): prepare the transaction envelope in-app** — PR #46 (`3a9ecde`).
  The app supplies gas, EIP-1559 fees and nonce so a wallet never reads its own
  node to build the transaction.
- **fix(rpc,wallet): fail over a stalled RPC endpoint** — PR #45 (`db73fe8`).
- **fix(wallet): Trust Wallet RPC independence for Monad** — PR #44 (`2b5d665`).
- **feat(rpc): application-owned RPC recovery and wallet-safe failure copy** —
  PR #43 (`a066c6e`).
- **fix(wallet): de-duplicate a wallet in the picker and fail over receipt reads** —
  PR #42 (`38636c1`).
- **fix(security): force patched zod via overrides** — PR #41 (`0c4aad2`).
- **fix(wallet): restore direct injected-wallet connect** — PR #39 (`572743d`).
- **fix(wallet,rpc): recover a late mobile provider and a transiently empty read** —
  PR #38 (`69ea6d6`).
- **fix(rpc): fail over to the public Monad RPC** — PR #37 (`8472a73`).
- **fix(wallet): discover late-injected Trust Wallet and harden checkout payload** —
  PR #36 (`084b974`).
- **fix(wallet): repair mobile WalletConnect connect and blank checkout** —
  PR #35 (`b593f1f`).
- **docs: real-wallet validation runbook** — PR #34 (`1d270eb`).
- **fix(checkout): confirm each transaction before sending the next** —
  PR #33 (`ef07fea`).
- **fix(settlement): verify every transaction a multi-step plan broadcast** —
  PR #32 (`705e0e9`).
- **fix(webhooks): drain the expiry event on the read that triggers it** —
  PR #31 (`1b5f4a7`).

## 2026-10 — Merchant infrastructure, developer API and SDK

- **feat(merchant): independent merchant integration example + pilot UX** —
  PR #28 (`a5654ea`).
- **feat(checkout): checkout-bound attribution via watch-only xpub** —
  PRs #26 (`5d5f4ba`), #29 (`82185a6`).
- **feat(checkout): recommend and explain checkout-bound attribution** —
  PR #27 (`25dfd42`).
- **feat(settlement): replay-resistant payment attribution** — PR #25 (`2253abd`).
- **feat(webhooks): deliver checkout events promptly via a scheduled drain** —
  PR #24 (`924e9b4`).
- **feat(checkout): merchant checkout infrastructure over the v1 API** —
  PR #23 (`bc7c4f8`).
- **feat(sdk): TypeScript SDK for the v1 developer API** — PR #22 (`2e61e4d`).
- **feat(api): external developer API v1 (intents, webhooks, settlement)** —
  PR #21 (`af49c4a`).
- **feat(wallet): multi-wallet connectivity (EIP-6963 + WalletConnect)** —
  PR #20 (`eaf7ea9`).
- **fix(security): require patched Node.js 24 runtime** — `6715b3f`.
- **feat(store): durable referral storage via managed Postgres** —
  PR #17 (`cadc326`).
- **feat: production hardening (store, auth, ops/cost) + user referral system** —
  PR #16 (`2423aaf`).
- **feat(brand): favicon, icons, social metadata, robots/sitemap** —
  PR #15 (`3acda53`).
- **security: hardening headers/CSP, stop upstream error secrets, no-store APIs** —
  PR #14 (`25e22b8`).

## 2026-09 — Payment correctness

- **fix(payments): preserve the real transaction-failure cause** — PR #13 (`6449fa3`).
- **fix(gas): gas-derived native MON reserve + consistent fee-shortfall messaging** —
  PR #12 (`b226512`).
- **fix(payments): account gas across the whole plan; no minimum transfer** —
  PR #9 (`ddf9d32`).
- **fix(payment): honest transaction outcomes, actionable errors, crash-proof UI** —
  PR #8 (`b6c5d08`).
- **feat: remove gas-abstraction stack, simplify to native-MON payment** —
  PR #4 (`d52f483`). There is no paymaster, bundler or account-abstraction path.
- **docs: clarify verified mainnet payment capabilities** — PR #7 (`38d8cd4`).

See [`docs/roadmap.md`](docs/roadmap.md) for the current status of each area.
