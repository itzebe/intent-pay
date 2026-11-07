import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const ecoDir = join(root, "docs/ecosystem");

/**
 * Monad ecosystem materials (Mission 29D).
 *
 * These documents are handed to an external ecosystem reviewer, so an honesty
 * regression here is worse than a broken link: an unverified grant claim, a
 * partnership that does not exist, or an SDK presented as published would be a
 * false statement made on the project's behalf. The invariants are asserted
 * directly, and each assertion is non-vacuous (it fails on a real regression).
 */
const DOCS = [
  "overview.md",
  "technical-architecture.md",
  "developer-opportunities.md",
  "merchant-use-cases.md",
  "demo-script.md",
  "project-faq.md",
  "outreach-drafts.md",
  "ecosystem-opportunities.md",
  "readiness.md",
  "merchant-validation-readiness.md",
  "sdk-publication-checklist.md",
] as const;

const read = (name: string) => readFileSync(join(ecoDir, name), "utf8");

describe("ecosystem materials exist", () => {
  it("ships every expected document, non-empty", () => {
    for (const name of DOCS) {
      const path = join(ecoDir, name);
      expect(existsSync(path), `${name} should exist`).toBe(true);
      expect(statSync(path).size, `${name} should be non-empty`).toBeGreaterThan(200);
    }
  });

  it("is referenced from the repository documentation index", () => {
    expect(readFileSync(join(root, "docs/index.md"), "utf8")).toContain("ecosystem/");
  });
});

describe("ecosystem materials stay honest", () => {
  it("never claims an official Monad relationship", () => {
    const corpus = DOCS.map(read).join("\n").toLowerCase();
    // Affirmative claim phrasings — none of these may appear. Denials such as
    // "Is this endorsed by Monad? No." or "no official Monad grants page" are
    // not affirmative claims and are deliberately allowed.
    const affirmative = [
      /in partnership with monad/,
      /official monad (partner|ambassador)/,
      /we (have )?received a monad grant/,
      /monad foundation (approved|backed|funded|endorsed)/,
      /(supported|funded|backed) by the monad foundation/,
    ];
    for (const pattern of affirmative) {
      expect(corpus).not.toMatch(pattern);
    }
    // The independence is stated explicitly somewhere.
    expect(corpus).toMatch(/no partnership|not affiliated|independent infrastructure/);
  });

  it("states plainly that the SDK is not published", () => {
    const sdk = read("sdk-publication-checklist.md").toLowerCase();
    expect(sdk).toMatch(/not published/);
    expect(sdk).toMatch(/blocked/);
    expect(sdk).toContain("registry.npmjs.org/@intentpay%2fsdk");
    expect(read("project-faq.md").toLowerCase()).toContain("not yet on npm");
  });

  it("marks the outreach drafts as drafts that must not be sent", () => {
    const drafts = read("outreach-drafts.md").toLowerCase();
    expect(drafts).toMatch(/draft/);
    expect(drafts).toMatch(/do not send/);
    expect(drafts).toMatch(/without the owner's explicit approval/);
  });

  it("records grants as unverified rather than asserting one exists", () => {
    const opp = read("ecosystem-opportunities.md").toLowerCase();
    expect(opp).toMatch(/unverified/);
    expect(opp).toMatch(/no official monad grants page/);
  });

  it("keeps the mainnet-only, no-refund, no-sandbox limits explicit", () => {
    const faq = read("project-faq.md").toLowerCase();
    expect(faq).toMatch(/mainnet only/);
    expect(faq).toMatch(/no refund endpoint/);
    expect(faq).toMatch(/sandbox/);
  });
});

describe("ecosystem materials carry no secrets", () => {
  it("contains no private-key, seed-phrase or token material", () => {
    const corpus = DOCS.map(read).join("\n");
    // A 64-hex private key, a labelled secret value, or a bearer/JWT token.
    // A bare *mention* of the words (e.g. "no seed phrase is ever requested")
    // is a policy statement, not a secret, so the value must be required.
    expect(corpus).not.toMatch(/0x[a-fA-F0-9]{64}/);
    expect(corpus).not.toMatch(/(private key|seed phrase)\s*[:=]\s*\S/i);
    expect(corpus).not.toMatch(/\beyJ[A-Za-z0-9_-]{20,}/);
    expect(corpus).not.toMatch(/\bghp_[A-Za-z0-9]{20,}/);
  });
});
