# SDK publication readiness — `@intentpay/sdk`

**Status: NOT PUBLISHED. Publication is BLOCKED.** The package builds and packs
cleanly, but the npm scope is not held by the owner and no npm credential is
available. Do not bypass the block.

## Verified locally (2026-11-07)

- `npm run build` (tsup) succeeds: ESM + CJS + type declarations for the root,
  `./wallet` and `./webhooks` entry points.
- `npm pack --dry-run` produces `intentpay-sdk-0.1.0.tgz` — 23 files, 136.6 kB
  packed / 520.0 kB unpacked — and includes `LICENSE` (MIT) and `README.md`.
- `dist/` is gitignored; no build artifact is committed.
- The package is `sideEffects: false`, dual ESM/CJS, with optional
  `@walletconnect/ethereum-provider` as a peer dependency.

## The block

| Item | Value |
| --- | --- |
| Package name | `@intentpay/sdk` |
| npm registry lookup | `https://registry.npmjs.org/@intentpay%2Fsdk` -> **404** (unpublished) |
| npm scope `@intentpay` | **not held** by the owner (org lookup 404) |
| npm credentials in the environment | **none** (`npm whoami` -> `ENEEDAUTH`) |

Publishing requires the owner to control the `@intentpay` npm scope and to
authenticate. The agent cannot and must not attempt to claim a scope, create an
account, or publish.

## Publication checklist (owner-driven)

- [ ] Owner holds (or creates) the `@intentpay` npm scope, or chooses a scope they
      control and the package name is updated accordingly.
- [ ] Owner authenticates npm locally (`npm login`) or provides a scoped
      automation token via the normal secrets channel.
- [ ] Confirm the version (`0.1.0`) and the repository/`directory` fields.
- [ ] Re-run `npm run build && npm run typecheck && npm test` in `packages/sdk`.
- [ ] `npm pack --dry-run` reviewed (contents, size, LICENSE, README).
- [ ] Publish: `npm publish --access public` from `packages/sdk`.
- [ ] Verify: `npm view @intentpay/sdk version` and install in a scratch project.
- [ ] Tag the release in git.

## Until then

- Consumers install from the built tarball:
  `npm install ./packages/sdk` (after `npm run build` in `packages/sdk`).
- The SDK is usable from the repository; only distribution is blocked.
- Nothing in the SDK's behaviour changes at publication — it is a distribution
  step, not a feature.
