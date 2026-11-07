# Ecosystem readiness

An honest assessment of what is ready for Monad ecosystem engagement and what is
not. Verified sources and dates are in `ecosystem-opportunities.md` and in the
project memory.

## Ready

- **A live, working product.** Non-custodial payments on Monad Mainnet, with
  routing, guarded signing, verified settlement and honest failure.
- **A developer surface.** Versioned API, SDK, webhooks, capabilities endpoint,
  quickstart and a runnable example.
- **A merchant surface.** Hosted checkout, payment links/QR, order attribution,
  settlement evidence and a merchant console.
- **Technical materials.** Overview, architecture, demo scripts and FAQ, all
  consistent with the repository.
- **A product story.** One coherent story across the public pages (Mission 29C),
  with a WCAG 2.2 AA contrast floor.

## Not ready / blocked

- **npm publication of `@intentpay/sdk`** — BLOCKED. The package builds and packs
  cleanly (LICENSE included), but the `@intentpay` scope is not held by the owner
  and no npm credential is available. Do not bypass; see
  `sdk-publication-checklist.md`.
- **Self-service merchant registration UI** — developer signup is self-service
  (email-verified); registering a merchant's receive address/xpub in the same UI
  is planned, not built.
- **Sandbox / testnet** — none exists; this is a mainnet-only product.
- **Refunds** — no endpoint.
- **Real merchant validation** — a real merchant has not completed and
  independently verified a live order. See `merchant-validation-readiness.md`.
- **Third-party developer integration** — no external integrator has built
  against the API yet.

## Evidence discipline

Distinguish these — they are not interchangeable:

| Evidence type | What it proves |
| --- | --- |
| Automated integration tests | Logic and invariants hold in isolation |
| Local end-to-end tests | The lifecycle runs against a local server |
| Production HTTP smoke tests | Routes respond; content is served |
| Merchant acceptance tests | A merchant can complete the workflow |
| Real Mainnet payment tests | A real payment settles and is verified |

A successful local test is **not** proof of a successful production merchant
transaction. A real Mainnet payment test requires explicit owner authorization
and is not performed by the agent.

## Next steps (owner decisions)

1. Review and approve (or edit) the outreach drafts.
2. Decide whether to acquire the npm scope for publication.
3. Approve a real merchant validation run (`merchant-validation-readiness.md`).
4. Choose which ecosystem entry points to approach, from the researched list.
