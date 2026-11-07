import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ROUTES } from "@/lib/config/site";

const root = join(__dirname, "..");

/**
 * Discoverability and repository documentation.
 *
 * These are easy to break silently — a `llms.txt` that drifts from the served
 * copy, a linked document that does not exist, a top-level product route missing
 * from the sitemap. They are asserted directly.
 */
describe("llms.txt", () => {
  const repoCopy = join(root, "llms.txt");
  const servedCopy = join(root, "public/llms.txt");

  it("exists at the repository root and is non-empty", () => {
    expect(existsSync(repoCopy)).toBe(true);
    expect(statSync(repoCopy).size).toBeGreaterThan(500);
  });

  it("is served verbatim from the site (no drift between the two copies)", () => {
    expect(existsSync(servedCopy), "public/llms.txt missing").toBe(true);
    expect(readFileSync(servedCopy, "utf8")).toBe(readFileSync(repoCopy, "utf8"));
  });

  it("links only to documentation files that exist on disk", () => {
    const body = readFileSync(repoCopy, "utf8");
    const links = [...body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(5);
    for (const href of links) {
      if (/^https?:/.test(href)) continue;
      expect(existsSync(join(root, href)), `llms.txt link missing: ${href}`).toBe(true);
    }
  });
});

describe("repository documentation", () => {
  const docs = [
    "docs/index.md",
    "docs/vision.md",
    "docs/product.md",
    "docs/architecture.md",
    "docs/security.md",
    "docs/developers.md",
    "docs/merchants.md",
    "docs/roadmap.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
  ];

  it("ships every documented file", () => {
    for (const f of docs) {
      expect(existsSync(join(root, f)), `${f} missing`).toBe(true);
      expect(statSync(join(root, f)).size).toBeGreaterThan(400);
    }
  });

  it("keeps the docs index linking every document", () => {
    const index = readFileSync(join(root, "docs/index.md"), "utf8");
    for (const f of docs) {
      if (f === "docs/index.md") continue;
      expect(index, `docs/index.md does not link ${f}`).toContain(f.replace("docs/", ""));
    }
  });
});

describe("top-level product routes are discoverable", () => {
  it("lists the product, developer and merchant pages in the public routes", () => {
    const paths = PUBLIC_ROUTES.map((r) => r.path);
    expect(paths).toContain("/product");
    expect(paths).toContain("/developers");
    expect(paths).toContain("/merchants");
  });

  it("resolves each to a real page on disk", () => {
    for (const p of ["/product", "/developers", "/merchants"]) {
      expect(existsSync(join(root, `app${p}/page.tsx`)), `${p} missing`).toBe(true);
    }
  });
});
