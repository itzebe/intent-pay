import { describe, expect, it } from "vitest";
import { createWalletClient, custom, defineChain, type Address } from "viem";
import { httpsEndpoints, isHttpsUrl } from "@/lib/rpc/endpoints";
import {
  classifyTransactionError,
  isTransportError,
  isWalletTransportFailure,
} from "@/lib/domain/transactionError";
import { sendCallsSequentially, type RawCall } from "@/lib/wallet/sendCalls";

/**
 * Application-owned RPC recovery and the wallet/RPC boundary.
 *
 * Intent Pay performs every chain read — balances, token metadata, quotes, gas
 * price, receipts, settlement — through its *own* HTTPS clients. The user's
 * wallet is only asked to authorise a transaction. Two rules keep that boundary
 * honest, and a wrong diagnosis of "which side failed" is what sent users to
 * "check your RPC URL" for a wallet-side problem they could not fix:
 *
 *   1. every application-owned endpoint is HTTPS, enforced in one place, so a
 *      plaintext endpoint is dropped rather than silently downgrading reads;
 *   2. a transport failure the *wallet's* provider hit is reported as the
 *      wallet's, never as our RPC being unreachable, and never as a payment that
 *      failed when nothing was submitted.
 */

const ENV_KEYS = ["NEXT_PUBLIC_MONAD_RPC_URL", "NEXT_PUBLIC_ALCHEMY_API_KEY", "MONAD_RPC_URL"] as const;

async function withEnv<T>(
  env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  run: () => Promise<T> | T,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k] as string;
  }
  try {
    return await run();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  }
}

describe("application-owned RPC endpoints are HTTPS-only", () => {
  it("accepts https and rejects http, malformed and empty values", () => {
    expect(isHttpsUrl("https://rpc.monad.xyz")).toBe(true);
    expect(isHttpsUrl("http://rpc.monad.xyz")).toBe(false);
    expect(isHttpsUrl("http://monad.twnodes.com")).toBe(false);
    expect(isHttpsUrl("rpc.monad.xyz")).toBe(false);
    expect(isHttpsUrl("")).toBe(false);
  });

  it("drops a plaintext endpoint and de-duplicates, preserving order", () => {
    expect(
      httpsEndpoints([
        "http://insecure.example",
        "https://a.example",
        "https://a.example",
        null,
        undefined,
        "https://b.example",
      ]),
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  it("a configured plaintext RPC is dropped; the HTTPS public RPC remains", async () => {
    const { browserRpcUrls, PUBLIC_MONAD_RPC } = await import("@/lib/config/chains");
    await withEnv({ NEXT_PUBLIC_MONAD_RPC_URL: "http://monad.twnodes.com", NEXT_PUBLIC_ALCHEMY_API_KEY: undefined }, () => {
      const urls = browserRpcUrls();
      expect(urls).not.toContain("http://monad.twnodes.com");
      expect(urls).toContain(PUBLIC_MONAD_RPC);
      for (const u of urls) expect(u).toMatch(/^https:\/\//);
    });
  });

  it("the EIP-3085 add-chain payload never carries a plaintext RPC", async () => {
    const { monadAddChainParams } = await import("@/lib/wallet/monadChain");
    await withEnv({ NEXT_PUBLIC_MONAD_RPC_URL: "http://monad.twnodes.com", NEXT_PUBLIC_ALCHEMY_API_KEY: undefined }, () => {
      const params = monadAddChainParams("mainnet");
      for (const u of params.rpcUrls) expect(u).toMatch(/^https:\/\//);
      expect(JSON.stringify(params)).not.toContain("http://");
    });
  });
});

describe("isTransportError / isWalletTransportFailure", () => {
  it("recognises transport shapes along the cause chain", () => {
    expect(isTransportError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransportError({ cause: { message: "Load failed" } })).toBe(true);
    expect(isTransportError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(isTransportError({ code: 4001, message: "User rejected the request." })).toBe(false);
  });

  it("only treats a step-tagged submission failure as the wallet's", () => {
    const walletErr = Object.assign(new Error("The transaction could not be sent."), {
      code: "unknown",
      stepId: "swap-0",
      cause: new TypeError("Failed to fetch"),
    });
    expect(isWalletTransportFailure(walletErr)).toBe(true);

    // Our own RPC failing has no step id (it is not a submission).
    const appErr = Object.assign(new Error("Failed to fetch"), { code: -32603 });
    expect(isWalletTransportFailure(appErr)).toBe(false);
  });
});

describe("classifyTransactionError distinguishes the wallet's RPC from ours", () => {
  const transport = new TypeError("Failed to fetch");

  it("with source 'wallet' it is a wallet_rpc failure that MAY have submitted", () => {
    const info = classifyTransactionError(transport, { source: "wallet" });
    expect(info.kind).toBe("wallet_rpc");
    // The wallet is asked to send only after the user authorised, so a transport
    // failure does not prove nothing was broadcast: it is an unknown outcome.
    expect(info.mayHaveSubmitted).toBe(true);
    expect(info.message).toMatch(/may already be on Monad|authorised the payment/i);
    expect(info.message).toMatch(/do not submit another payment/i);
    // It must not claim our RPC is down, and it must not claim nothing was sent.
    expect(info.message).not.toMatch(/network provider is temporarily unavailable/i);
    expect(info.message).not.toMatch(/was not sent/i);
    expect(info.action).toBe("Check status");
  });

  it("recognises the Trust Wallet connection-error shapes as transport failures", () => {
    // The exact phrase Trust Wallet's native layer raises after password entry.
    expect(isTransportError(new TypeError("Failed to connect to http://monad.twnodes.com/"))).toBe(true);
    expect(isTransportError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(true);
    expect(isTransportError(new Error("ERR_NAME_NOT_RESOLVED"))).toBe(true);
    expect(isTransportError(new Error("Could not connect to the server"))).toBe(true);
  });

  it("with the default source it stays the honest rpc_unavailable outcome", () => {
    const info = classifyTransactionError(transport);
    expect(info.kind).toBe("rpc_unavailable");
    expect(info.mayHaveSubmitted).toBe(true);
    expect(info.action).toBe("Check status");
  });

  it("still prefers a user rejection over a transport reading, for either source", () => {
    for (const source of ["app", "wallet"] as const) {
      const info = classifyTransactionError({ code: 4001, message: "Failed to fetch" }, { source });
      expect(info.kind).toBe("rejected");
    }
  });
});

describe("sendCallsSequentially keeps the real cause for classification", () => {
  const calls: RawCall[] = [{ to: `0x${"1".repeat(40)}`, data: "0x", value: "0" }];

  it("returns the thrown send error as `cause` on a send_failed outcome", async () => {
    const thrown = new TypeError("Failed to fetch");
    const outcome = await sendCallsSequentially({
      calls,
      send: async () => {
        throw thrown;
      },
      waitForReceipt: async () => ({ status: "success" }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("send_failed");
    expect(outcome.cause).toBe(thrown);
    // The cause is what lets the checkout say "your wallet could not complete
    // its network request" instead of a generic "transaction could not be sent".
    expect(isTransportError(outcome.cause)).toBe(true);
  });

  it("does not attach a cause to a user rejection (it is not a transport fault)", async () => {
    const outcome = await sendCallsSequentially({
      calls,
      send: async () => {
        throw { code: 4001, message: "User rejected the request." };
      },
      waitForReceipt: async () => ({ status: "success" }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("rejected");
    expect(isTransportError(outcome.cause)).toBe(false);
  });
});

/**
 * The wallet/RPC boundary itself.
 *
 * Intent Pay signs and broadcasts through the user's wallet, but every *read* —
 * gas price, nonce, receipt — is made through our own HTTPS client. This is what
 * makes an application-owned RPC recovery possible at all: the wallet is never
 * asked to answer a chain read, so a wallet whose own node is unreachable cannot
 * take our quote, gas or receipt path down with it.
 */
describe("the wallet is asked to sign and broadcast, never to read", () => {
  const monad = defineChain({
    id: 143,
    name: "Monad",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
  });
  const ACCOUNT = "0x0000000000000000000000000000000000000001" as Address;
  const TOKEN = "0x0000000000000000000000000000000000000002" as Address;

  function recordingProvider() {
    const methods: string[] = [];
    const provider = {
      request: async ({ method }: { method: string }) => {
        methods.push(method);
        if (method === "eth_chainId") return "0x8f";
        if (method === "eth_sendTransaction") return `0x${"ab".repeat(32)}`;
        return "0x0";
      },
    };
    return { provider, methods };
  }

  it("a writeContract only sends eth_chainId + eth_sendTransaction to the wallet", async () => {
    const { provider, methods } = recordingProvider();
    const walletClient = createWalletClient({
      account: ACCOUNT,
      chain: monad,
      transport: custom(provider as never),
    });
    const ABI = [
      {
        name: "transfer",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ] as const;

    await walletClient.writeContract({
      account: ACCOUNT,
      chain: monad,
      address: TOKEN,
      abi: ABI,
      functionName: "transfer",
      args: [ACCOUNT, 1n],
    });

    // The wallet is never asked for gas, nonce, balances or a receipt.
    expect(methods).toEqual(["eth_chainId", "eth_sendTransaction"]);
    for (const read of [
      "eth_estimateGas",
      "eth_gasPrice",
      "eth_getTransactionCount",
      "eth_call",
      "eth_getBalance",
      "eth_getTransactionReceipt",
    ]) {
      expect(methods).not.toContain(read);
    }
  });
});
