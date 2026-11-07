# Intent Pay documentation

This directory is the repository-level technical record of Intent Pay. It is
written for engineers, reviewers, integrators and ecosystem contributors. The
in-app documentation at `/docs` is the user-facing equivalent; the two describe
the same system and neither invents capability.

| Document | What it covers |
| --- | --- |
| [vision.md](./vision.md) | Company vision, the problem, target audiences, product principles, scope and non-goals. |
| [product.md](./product.md) | Product capabilities and the individual, developer and merchant journeys. |
| [architecture.md](./architecture.md) | System architecture, layers, the payment lifecycle, RPC and trust boundaries. |
| [security.md](./security.md) | Non-custodial principles, submission invariants, ambiguous outcomes, disclosure. |
| [developers.md](./developers.md) | Developer onboarding: API usage, SDK setup, integration examples, testing. |
| [merchants.md](./merchants.md) | Merchant onboarding, checkout integration, status verification, reconciliation. |
| [roadmap.md](./roadmap.md) | Completed milestones, current work, next priorities and outstanding validation. |

Related repository files:

- [`../README.md`](../README.md) — repository landing page.
- [`../CHANGELOG.md`](../CHANGELOG.md) — technical milestones.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — development and PR workflow.
- [`../AGENTS.md`](../AGENTS.md) — the invariants an agent or contributor must not regress.
- [`../llms.txt`](../llms.txt) — a compact machine-oriented summary.
- [`../packages/sdk/README.md`](../packages/sdk/README.md) — SDK reference.
- [`../examples/`](../examples) — runnable quickstart and merchant examples.

## Status legend

Roadmap entries and capability statements use these categories:

- **COMPLETE** — implemented, tested and exercised against Monad Mainnet.
- **IN PROGRESS** — partly implemented; usable but not finished.
- **PLANNED** — designed or intended, not implemented.
- **BLOCKED** — cannot proceed without an external dependency.
- **NEEDS VALIDATION** — implemented, but a specific real-world check has not yet been performed.

## Network

Monad Mainnet, chain id **143**. Intent Pay is Monad-only; it is not a bridge and
does not claim cross-chain delivery.
