import { describe, expect, it } from "vitest";
import * as serverEntry from "../src/index.js";
import * as walletEntry from "../src/wallet/index.js";
import * as webhooksEntry from "../src/webhooks.js";

/**
 * The package's entry-point contract.
 *
 * The whole security story rests on the split: the keyed client is server-only
 * and the wallet layer is browser-only. These assertions fail loudly if someone
 * later re-exports wallet code from the server entry (which would drag DOM code
 * and an EIP-1193 dependency into a server bundle) or the reverse.
 */
describe("entry-point surface", () => {
  it("exposes the client from the server entry", () => {
    expect(typeof serverEntry.IntentPay).toBe("function");
    expect((serverEntry as Record<string, unknown>).verifyWebhookSignature).toBeUndefined();
  });

  it("keeps wallet code out of the server entry", () => {
    const server = serverEntry as Record<string, unknown>;
    expect(server.Wallet).toBeUndefined();
    expect(server.discoverWallets).toBeUndefined();
    expect(server.watchWallets).toBeUndefined();
  });

  it("exposes the wallet layer only from the wallet entry", () => {
    expect(typeof walletEntry.Wallet).toBe("function");
    expect(typeof walletEntry.discoverWallets).toBe("function");
    expect(typeof walletEntry.watchWallets).toBe("function");
    expect(walletEntry.MONAD_CHAIN_ID).toBe(143);
    // The client is not re-exported here either.
    expect((walletEntry as Record<string, unknown>).IntentPay).toBeUndefined();
  });

  it("exposes webhook verification from its own entry", () => {
    expect(typeof webhooksEntry.verifyWebhookSignature).toBe("function");
    expect(typeof webhooksEntry.computeWebhookSignature).toBe("function");
  });

  it("namespaces its error classes", () => {
    expect(typeof serverEntry.ApiError).toBe("function");
    expect(typeof serverEntry.TransportError).toBe("function");
    expect(typeof serverEntry.ConfigurationError).toBe("function");
    expect(typeof walletEntry.WalletError).toBe("function");
  });
});
