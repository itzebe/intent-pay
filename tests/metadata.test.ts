import { describe, expect, it } from "vitest";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { metadata } from "@/app/layout";
import { SITE_URL, PUBLIC_ROUTES } from "@/lib/config/site";

const root = join(__dirname, "..");

/**
 * Metadata and crawl resources. These are easy to break silently (a mistyped
 * icon filename, a dropped `alternates`, a sitemap that drifts from the real
 * routes), so they are asserted directly.
 */
describe("brand assets exist and are real images", () => {
  it("ships favicon, SVG icon, apple icon and social images", () => {
    for (const f of [
      "app/favicon.ico",
      "app/icon.svg",
      "app/apple-icon.png",
      "app/opengraph-image.png",
      "app/twitter-image.png",
    ]) {
      expect(existsSync(join(root, f)), `${f} missing`).toBe(true);
      expect(statSync(join(root, f)).size).toBeGreaterThan(0);
    }
  });

  it("emits a PNG-compressed multi-size .ico", () => {
    const buf = readFileSync(join(root, "app/favicon.ico"));
    expect(buf.readUInt16LE(0)).toBe(0); // reserved
    expect(buf.readUInt16LE(2)).toBe(1); // type: icon
    const count = buf.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < count; i += 1) {
      const off = buf.readUInt32LE(6 + i * 16 + 12);
      // Each entry starts with the PNG signature.
      expect(buf.subarray(off, off + 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  });

  it("keeps the source SVGs out of the routable app directory (no metadata conflict)", () => {
    expect(existsSync(join(root, "app/opengraph-image.svg"))).toBe(false);
    expect(existsSync(join(root, "app/twitter-image.svg"))).toBe(false);
  });
});

describe("page metadata", () => {
  it("resolves canonical and social URLs against the site origin", () => {
    expect(metadata.metadataBase?.toString().replace(/\/$/, "")).toBe(SITE_URL);
    expect(metadata.alternates?.canonical).toBe("/");
    expect(metadata.openGraph?.url).toBe("/");
    expect(metadata.openGraph?.siteName).toBe("Intent Pay");
    expect(metadata.twitter?.site).toBe("@IntentPayApp");
    expect(metadata.twitter?.creator).toBe("@IntentPayApp");
    // `card` is present at runtime; the exported type is narrower than the input.
    expect((metadata.twitter as { card?: string } | undefined)?.card).toBe(
      "summary_large_image",
    );
  });

  it("has a non-empty title and description", () => {
    const title = metadata.title as { default: string };
    expect(title.default).toContain("Intent Pay");
    expect(String(metadata.description).length).toBeGreaterThan(40);
  });
});

describe("robots.txt", () => {
  const r = robots();

  it("allows the app and disallows the per-user API", () => {
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rules.userAgent).toBe("*");
    expect(rules.allow).toBe("/");
    expect(rules.disallow).toBe("/api/");
  });

  it("advertises the absolute sitemap URL on the canonical origin", () => {
    expect(r.sitemap).toBe(`${SITE_URL}/sitemap.xml`);
    expect(r.host).toBe(SITE_URL);
  });
});

describe("sitemap.xml", () => {
  const entries = sitemap();

  it("lists every public route as an absolute URL on the canonical origin", () => {
    expect(entries.map((e) => e.url)).toEqual(
      PUBLIC_ROUTES.map((r) => `${SITE_URL}${r.path}`),
    );
  });

  it("never lists an API route", () => {
    for (const e of entries) expect(e.url).not.toContain("/api/");
  });

  it("gives the homepage the highest priority", () => {
    const home = entries.find((e) => e.url === `${SITE_URL}/`);
    expect(home?.priority).toBe(1);
  });
});

describe("public route config", () => {
  it("covers the homepage and every documentation page", () => {
    const paths = PUBLIC_ROUTES.map((r) => r.path);
    expect(paths).toContain("/");
    for (const p of [
      "/docs",
      "/docs/litepaper",
      "/docs/how-it-works",
      "/docs/architecture",
      "/docs/security",
      "/docs/roadmap",
      "/docs/faq",
      "/docs/developers",
    ]) {
      expect(paths).toContain(p);
    }
  });

  it("does not drift from the pages that actually exist on disk", () => {
    // Each advertised route must resolve to a real `page.tsx` (the sitemap must
    // never list a route the app does not serve).
    for (const { path } of PUBLIC_ROUTES) {
      const file = path === "/" ? "app/page.tsx" : `app${path}/page.tsx`;
      expect(existsSync(join(root, file)), `${path} -> ${file}`).toBe(true);
    }
  });
});
