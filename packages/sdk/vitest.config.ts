import { defineConfig } from "vitest/config";

export default defineConfig({
  // An inline, empty PostCSS config stops Vite from walking up to the
  // application's Tailwind config at the repository root, which this package
  // does not install (a standalone `npm ci` here has no `tailwindcss`).
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // A cold live deployment builds the routing graph and prices tokens on the
    // first prepare, which can exceed vitest's 5s default. The client's own
    // request timeout is 30s, so the per-test budget is set above it — a healthy
    // but cold deployment must not fail a live run for the wrong reason.
    testTimeout: 45_000,
  },
});
