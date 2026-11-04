import { describe, expect, it } from "vitest";
import { IntentPay } from "../src/index.js";
import { Wallet } from "../src/wallet/index.js";
import { installLegacyWindow, makeProvider } from "./fakeWallet.js";

/**
 * End-to-end wallet → payment-engine integration, against a live server.
 *
 * This is the "a connected wallet must be usable with the existing payment
 * engine" check, and it is written in the **production architecture**: the
 * `IntentPay` client (which holds the API key) runs on the server and does every
 * credential-bearing call; the browser only discovers the wallet, gets it onto
 * Monad, and signs the calls the server prepared. The browser never sees the API
 * key — the SDK refuses to construct a keyed client in a browser at all.
 *
 * The real API runs (real validation, real Monad routing, real transaction
 * preparation) and the real wallet layer runs (real EIP-1193 discovery, Monad
 * enforcement, `eth_sendTransaction`). The only simulated part is the wallet's
 * own signing — there is no funded key in CI — so the broadcast hash is not a
 * real Monad transaction. Everything up to and including the send request is
 * genuine.
 *
 * Skipped unless `INTENTPAY_BASE_URL` and `INTENTPAY_API_KEY` are set.
 */

const baseUrl = process.env.INTENTPAY_BASE_URL;
const apiKey = process.env.INTENTPAY_API_KEY;
const enabled = Boolean(baseUrl && apiKey);
const suite = enabled ? describe : describe.skip;

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const RECIPIENT = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

/**
 * The server side: holds the credential, never runs in a browser.
 *
 * `dangerouslyAllowBrowser` is set only because this one process emulates both
 * sides of the split — it installs a fake `window` to drive the wallet layer and
 * also constructs the keyed client that a real deployment would run on a server.
 * `test/config.test.ts` proves the guard itself refuses the same combination
 * when the flag is absent.
 */
function server(): IntentPay {
  return new IntentPay({ apiKey: apiKey!, baseUrl: baseUrl!, timeoutMs: 30_000, dangerouslyAllowBrowser: true });
}

suite("wallet → engine integration (live)", () => {
  it("connects a wallet and pays through the engine", async () => {
    const provider = makeProvider({ accounts: [SENDER], chainId: "0x8f" });
    const cleanup = installLegacyWindow(provider);
    try {
      const api = server();

      // 1. Browser: discover, connect, and confirm Monad.
      const wallet = await Wallet.connect();
      expect(wallet.address).toBe(SENDER);
      expect(wallet.onMonad).toBe(true);
      await wallet.ensureMonadChain();

      // 2. Server: create and validate a real intent.
      const created = await api.createIntent({
        recipient: RECIPIENT,
        receiveToken: "USDC",
        amount: "1",
        idempotencyKey: `wallet-flow-${Date.now()}`,
      });
      const id = created.intent.id;
      expect((await api.validateIntent(id)).valid).toBe(true);

      // 3. Server: prepare the calls (no signature, no broadcast).
      const prepared = await api.prepareTransaction(id, { sender: wallet.address });
      expect(prepared.calls.length).toBeGreaterThan(0);

      // 4. Browser: the wallet signs and broadcasts the prepared calls.
      const sent = await wallet.sendCalls(prepared.calls);
      expect(sent.txHashes.length).toBe(prepared.calls.length);
      const sends = provider.calls.filter((c) => c.method === "eth_sendTransaction");
      const first = (sends[0]!.params as { to: string }[])[0]!;
      expect(first.to).toBe(prepared.calls[0]!.to);

      // 5. Server: freeze, then record the broadcast hash.
      await api.authorizeIntent(id);
      const submitted = await api.submitTransaction(id, { txHashes: sent.txHashes });
      expect(submitted.intent.state).toBe("submitted");

      // 6. Server: verification is honest — this hash is not on Monad.
      const verified = await api.verifySettlement(id, { txHash: sent.txHashes[0]! });
      expect(verified.verdict).not.toBe("verified");
      expect((await api.getPaymentStatus(id)).settled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("refuses to send when the wallet is on the wrong chain and will not switch", async () => {
    const provider = makeProvider({ accounts: [SENDER], chainId: "0x1", rejectSwitch: { code: 4001 } });
    const cleanup = installLegacyWindow(provider);
    try {
      const wallet = await Wallet.connect();
      expect(wallet.onMonad).toBe(false);
      await expect(wallet.sendCalls([{ to: RECIPIENT, data: "0x", value: "0" }])).rejects.toMatchObject({
        walletCode: "wallet_wrong_chain",
      });
      expect(provider.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("surfaces a wallet rejection without recording a payment", async () => {
    const provider = makeProvider({ accounts: [SENDER], chainId: "0x8f", rejectSend: { code: 4001 } });
    const cleanup = installLegacyWindow(provider);
    try {
      const api = server();
      const wallet = await Wallet.connect();
      const created = await api.createIntent({
        recipient: RECIPIENT,
        receiveToken: "USDC",
        amount: "1",
        idempotencyKey: `wallet-reject-${Date.now()}`,
      });
      const prepared = await api.prepareTransaction(created.intent.id, { sender: wallet.address });
      await expect(wallet.sendCalls(prepared.calls)).rejects.toMatchObject({ walletCode: "wallet_rejected" });
      const status = await api.getPaymentStatus(created.intent.id);
      expect(status.settled).toBe(false);
      expect(status.state).not.toBe("submitted");
    } finally {
      cleanup();
    }
  });
});
