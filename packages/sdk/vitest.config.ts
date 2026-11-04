import { defineConfig } from "vitest/config";

export default defineConfig({
  // An inline, empty PostCSS config stops Vite from walking up to the
  // application's Tailwind config at the repository root, which this package
  // does not install (a standalone `npm ci` here has no `tailwindcss`).
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
