// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("framer-motion", () => ({
  motion: new Proxy({}, { get: () => (props: Record<string, unknown>) => React.createElement("div", props) }),
}));

import { SiteHeader } from "@/components/landing/SiteHeader";
import { PUBLIC_ROUTES } from "@/lib/config/site";

/**
 * Product-experience truthfulness (Mission 29C).
 *
 * The marketing surface makes claims about a real payment system. These tests
 * pin the story to the product: the homepage must answer the core questions,
 * navigation must point at real pages, no adoption claim may be fabricated, and
 * readable text must clear WCAG 2.2 AA contrast on the dark background.
 */

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

afterEach(() => cleanup());

describe("homepage tells one coherent story", () => {
  const hero = read("components/landing/Hero.tsx");
  const sections = read("components/landing/HomeSections.tsx");
  const shell = read("components/AppShell.tsx");

  it("leads with a plain-language benefit, not infrastructure jargon", () => {
    // The headline must say what the user gets.
    expect(hero).toMatch(/Pay anyone the token they asked for/);
    // The old jargon headline is gone.
    expect(hero).not.toMatch(/Payment infrastructure connecting payment intentions/);
  });

  it("states custody and verification plainly in the hero", () => {
    expect(hero).toMatch(/you approve it in your own wallet/i);
    expect(hero).toMatch(/settlement is verified on-chain/i);
  });

  it("explains the lifecycle once, not twice", () => {
    // Exactly one lifecycle/flow explanation is rendered on the homepage.
    expect(shell).toContain("<Lifecycle />");
    expect(shell).not.toContain("<HowItWorks");
    expect(hero).not.toMatch(/export function HowItWorks/);
  });

  it("answers why Monad, with no implied endorsement", () => {
    expect(sections).toMatch(/Why Monad/);
    expect(sections).toMatch(/not affiliated with, endorsed by or sponsored/i);
    expect(shell).toContain("<WhyMonad />");
  });

  it("routes each audience to the surface that exists", () => {
    for (const href of ["/developers", "/merchants"]) {
      expect(sections, `pathway missing ${href}`).toContain(href);
    }
    // The individual pathway points at the working composer.
    expect(sections).toContain('href: "#pay"');
  });
});

describe("homepage makes no fabricated adoption claim", () => {
  const surfaces = [
    "components/landing/Hero.tsx",
    "components/landing/HomeSections.tsx",
    "components/landing/SiteFooter.tsx",
    "app/product/page.tsx",
    "app/developers/page.tsx",
    "app/merchants/page.tsx",
  ].map(read);

  it("never invents merchants, users, volume or testimonials", () => {
    for (const src of surfaces) {
      expect(src).not.toMatch(/trusted by|backed by|testimonial|as seen on/i);
      expect(src).not.toMatch(/\b\d[\d,.]*\s*(merchants|businesses|customers|users|transactions)\b/i);
      expect(src).not.toMatch(/\$\d[\d,.]*\s*(in|of)\s*(volume|payments|processed)/i);
    }
  });

  it("never claims a Monad partnership or endorsement", () => {
    for (const src of surfaces) {
      expect(src).not.toMatch(/official (partner|partnership) of monad|monad foundation (partner|endorses)/i);
      expect(src).not.toMatch(/sponsored by monad/i);
    }
  });

  it("never claims a sandbox or refund capability that does not exist", () => {
    const merchants = read("app/merchants/page.tsx");
    expect(merchants).toMatch(/no sandbox|there is no sandbox/i);
    expect(merchants).toMatch(/refunds are not implemented/i);
  });
});

describe("readable text clears WCAG 2.2 AA contrast", () => {
  // WCAG relative luminance / contrast, mirroring the sRGB formula.
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const over = (alpha: number, bg: number[]) => bg.map((c) => Math.round(255 * alpha + (1 - alpha) * c));
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const BGS = [
    [8, 9, 11], // page #08090B
    [14, 16, 19], // ink-850
    [19, 21, 25], // ink-800
  ];

  it("any text-white/N below the floor would fail AA (so the floor is real)", () => {
    for (const bg of BGS) {
      // /40 is the highest failing level — prove it fails, so the floor matters.
      expect(ratio(over(0.4, bg), bg)).toBeLessThan(4.5);
      // /50 is the floor and must pass with margin.
      expect(ratio(over(0.5, bg), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("no readable text class uses an opacity below white/50 on public surfaces", () => {
    const dirs = [
      "components/landing",
      "components/docs",
      "components/composer",
      "components/wallet",
      "components/checkout",
      "components/merchant",
      "components/flow",
      "components/success",
      "components/ui",
      "app/product",
      "app/developers",
      "app/merchants",
      "app/docs",
    ];
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(root, d))) {
        const rel = `${d}/${e}`;
        if (statSync(join(root, rel)).isDirectory()) walk(rel);
        else if (rel.endsWith(".tsx")) files.push(rel);
      }
    };
    for (const d of dirs) if (existsSync(join(root, d))) walk(d);

    const offenders: string[] = [];
    // `text-white/15` is a decorative SVG stroke, not text — allow only that one.
    const pat = /text-white\/(\d+)/g;
    for (const f of files) {
      const body = read(f);
      for (const m of body.matchAll(pat)) {
        const n = Number(m[1]);
        if (n >= 50) continue;
        if (n === 15 && /stroke|svg|currentColor/i.test(body)) continue;
        offenders.push(`${f}: text-white/${n}`);
      }
    }
    expect(offenders, `sub-AA text opacity found:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("navigation and route integrity", () => {
  it("exposes the four audience destinations and marks the active one", () => {
    render(<SiteHeader />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const href of ["/product", "/developers", "/merchants", "/docs"]) {
      expect(nav.querySelector(`a[href="${href}"]`), `nav missing ${href}`).toBeTruthy();
    }
  });

  it("keeps every advertised public route resolvable on disk", () => {
    for (const { path } of PUBLIC_ROUTES) {
      const file = path === "/" ? "app/page.tsx" : `app${path}/page.tsx`;
      expect(existsSync(join(root, file)), `${path} -> ${file}`).toBe(true);
    }
  });

  it("keeps the metadata title/description aligned with the story", () => {
    const site = read("lib/config/site.ts");
    expect(site).toMatch(/Pay anyone the token they asked for/);
    expect(site).not.toMatch(/Review the route\. Send on Monad/);
  });
});
