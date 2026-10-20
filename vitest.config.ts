import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // `node:sqlite` is a Node builtin; never let Vite try to bundle it.
    server: { deps: { external: [/^node:sqlite$/] } },
  },
  ssr: { external: ["node:sqlite"] },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
