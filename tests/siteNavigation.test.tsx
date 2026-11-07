// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// The header is a client component that reads the current path. Mock the hook so
// the test can assert the active-route logic without a router.
const pathname = { current: "/" };
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

import { SiteHeader } from "@/components/landing/SiteHeader";
import { PUBLIC_ROUTES } from "@/lib/config/site";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The shared site header.
 *
 * It is the one navigation surface used by the app and every documentation page,
 * so a broken link or a missing route is a site-wide defect. These tests drive
 * the real component and assert:
 *  - the primary navigation exposes the product routes,
 *  - the active route is marked for assistive technology,
 *  - the mobile menu toggles and exposes the same links,
 *  - every primary destination resolves to a real page on disk.
 */

const PRIMARY = ["/product", "/developers", "/merchants", "/docs"] as const;

beforeEach(() => {
  pathname.current = "/";
});
afterEach(() => cleanup());

describe("SiteHeader", () => {
  it("renders the primary product navigation", () => {
    render(<SiteHeader />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const href of PRIMARY) {
      expect(nav.querySelector(`a[href="${href}"]`)).toBeTruthy();
    }
  });

  it("marks the current route as the active page", () => {
    pathname.current = "/developers";
    render(<SiteHeader />);
    const link = screen
      .getByRole("navigation", { name: "Primary" })
      .querySelector('a[href="/developers"]');
    expect(link?.getAttribute("aria-current")).toBe("page");
  });

  it("treats a nested documentation route as the Documentation section", () => {
    pathname.current = "/docs/security";
    render(<SiteHeader />);
    const link = screen
      .getByRole("navigation", { name: "Primary" })
      .querySelector('a[href="/docs"]');
    expect(link?.getAttribute("aria-current")).toBe("page");
  });

  it("opens and closes the mobile menu, exposing the same links", () => {
    render(<SiteHeader />);
    const toggle = screen.getByRole("button", { name: /open menu/i });
    expect(screen.queryByRole("navigation", { name: "Mobile" })).toBeNull();

    fireEvent.click(toggle);
    const mobile = screen.getByRole("navigation", { name: "Mobile" });
    for (const href of PRIMARY) {
      expect(mobile.querySelector(`a[href="${href}"]`)).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("button", { name: /close menu/i }));
    expect(screen.queryByRole("navigation", { name: "Mobile" })).toBeNull();
  });

  it("renders the provided action slot", () => {
    render(<SiteHeader actions={<a href="/connect">Connect</a>} />);
    expect(screen.getAllByText("Connect").length).toBeGreaterThan(0);
  });
});

describe("primary navigation targets exist", () => {
  it("resolves every primary destination to a real page on disk", () => {
    const root = join(__dirname, "..");
    for (const href of PRIMARY) {
      const file = `app${href}/page.tsx`;
      expect(existsSync(join(root, file)), `${href} -> ${file}`).toBe(true);
    }
  });

  it("lists every primary destination in the public routes", () => {
    const paths = PUBLIC_ROUTES.map((r) => r.path);
    for (const href of PRIMARY) expect(paths).toContain(href);
  });
});
