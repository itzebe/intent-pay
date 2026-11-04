import { defineConfig } from "tsup";

/**
 * The SDK ships three entry points, each as ESM + CJS with its own type
 * declarations:
 *
 *   @intentpay/sdk          — the server-safe client (no DOM, no wallet code)
 *   @intentpay/sdk/wallet   — the browser wallet layer (EIP-6963 + WalletConnect)
 *   @intentpay/sdk/webhooks — signature verification for your receiver
 *
 * The optional WalletConnect provider is `external`: it is the consumer's own
 * dependency, so the package never bundles a second copy (which would inflate a
 * consumer's bundle and break its own provider identity checks).
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "wallet/index": "src/wallet/index.ts",
    webhooks: "src/webhooks.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "es2022",
  external: ["viem", "@walletconnect/ethereum-provider"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
