# Contributing to Intent Pay

Thanks for helping improve Intent Pay. This document covers setup, workflow and
the expectations that keep the payment system safe.

## Before you start

Read [`AGENTS.md`](AGENTS.md). It lists the invariants that must not regress —
most importantly:

- **A transaction submission is never retried** (`retryCount: 0`).
- **A broadcast is not a success** — delivery is proven from the receipt.
- **The requested output asset is authoritative** — never silently substitute the
  asset the sender happens to hold.
- **Never fabricate** a price, route, transaction hash or balance.

If a change would touch wallet discovery, transaction submission, gas
preparation, receipt verification, the store schema, or an API contract, treat it
as high-risk: isolate it, test it, and prove the existing behaviour is unchanged.

## Development setup

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # vitest
npm run build    # production build + typecheck

# SDK
cd packages/sdk
npm run typecheck && npm test && npm run build
```

Copy `.env.example` to `.env.local` and fill only what you need. Most work needs
no key at all.

## Branch and PR workflow

1. Branch from `main` with a descriptive name
   (`fix/…`, `feat/…`, `docs/…`).
2. Keep the change focused. Do not modify unrelated files.
3. Run the full checks before opening a PR:

   ```bash
   npx tsc --noEmit --noUnusedLocals --noUnusedParameters
   npm test
   npm run build
   cd packages/sdk && npm test && npm run typecheck
   ```

4. Open a pull request that states what changed and why, and includes test
   evidence. If the change touches payment execution, state explicitly that
   execution behaviour was preserved (or describe exactly how it changed).
5. Merge only when all required checks pass. `main` deploys to production, so a
   merge is a release.

## Testing expectations

- Add or update tests for any behaviour change. Pure logic is tested directly;
  wallet discovery is tested against a fake `window`.
- Do not weaken or delete an existing test to make a change pass. If a test is
  wrong, explain why in the PR.
- When a test touches tokens or a cached provider, use **unique addresses/keys per
  test** — the token registry and `TtlCache` are module-level and leak state
  between cases otherwise.
- Live tests are gated (for example `MONAD_LIVE_TESTS=1`) and must stay skipped by
  default.

## Code quality

- TypeScript strict; no unused locals or parameters.
- Comments explain non-obvious invariants and trade-offs, not what the code
  already says.
- Prefer configuration over hardcoded token symbols, addresses or chains
  (`lib/config/*`, `lib/providers/constants.ts`).
- Keep server handlers stateless functions of their request body. Never key a
  cache by anything but user-supplied identity.

## Security expectations

- Never commit a secret, key, seed phrase or credential. `.env.example` uses
  placeholders only.
- Never return a raw upstream error to a client — sanitise it
  (`sanitizeUpstreamError`).
- Never accept, request, log or store a private key or seed phrase.
- Report a suspected vulnerability privately rather than in a public issue (see
  [`docs/security.md`](docs/security.md)).

## Commit messages

Use a conventional prefix (`feat`, `fix`, `docs`, `test`, `chore`, `refactor`,
`perf`) and a short, imperative summary. Explain the *why* in the body when it is
not obvious.
