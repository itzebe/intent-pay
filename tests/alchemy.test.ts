import { describe, expect, it, vi } from "vitest";
import {
  getWalletCapabilities,
  sendCalls,
  waitForCalls,
  resolveGasMode,
  alchemyPaymasterServiceUrl,
} from "@/lib/execution/alchemy";
import { gasCapabilities } from "@/lib/server/gasCapabilities";

/** A minimal EIP-1193 stub that records requests and returns canned results. */
function providerWith(handlers: Record<string, (params: any) => unknown>) {
  const calls: { method: string; params: any }[] = [];
  return {
    calls,
    request: vi.fn(async ({ method, params }: { method: string; params?: any }) => {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw new Error(`unsupported ${method}`);
      return h(params);
    }),
  };
}

describe("Alchemy EIP-5792 wallet capabilities", () => {
  it("reads atomic + paymaster support for the chain", async () => {
    const provider = providerWith({
      wallet_getCapabilities: () => ({
        "0x8f": {
          atomic: { status: "supported" },
          paymasterService: { supported: true },
        },
      }),
    });
    const caps = await getWalletCapabilities(provider as any, 143);
    expect(caps.atomicBatch).toBe(true);
    expect(caps.paymasterService).toBe(true);
  });

  it("reports no support when the wallet throws", async () => {
    const provider = { request: vi.fn(async () => { throw new Error("nope"); }) };
    const caps = await getWalletCapabilities(provider as any, 143);
    expect(caps).toEqual({ atomicBatch: false, paymasterService: false, erc20GasPayment: false });
  });

  it("sendCalls sends the ERC-7677 paymaster service URL + context, not a bare policy id", async () => {
    const provider = providerWith({ wallet_sendCalls: () => ({ id: "0xabc" }) });
    const id = await sendCalls(provider as any, {
      from: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
      chainId: 143,
      calls: [{ to: "0x0000000000000000000000000000000000000001" as const }],
      paymasterServiceUrl: "https://monad-mainnet.g.alchemy.com/v2/key",
      paymasterContext: { policyId: "pol_123" },
    });
    expect(id).toBe("0xabc");
    const [call] = provider.calls;
    expect(call.method).toBe("wallet_sendCalls");
    expect(call.params[0].chainId).toBe("0x8f");
    expect(call.params[0].capabilities.paymasterService.url).toBe(
      "https://monad-mainnet.g.alchemy.com/v2/key",
    );
    expect(call.params[0].capabilities.paymasterService.context.policyId).toBe("pol_123");
    // A bare policy id is not a valid capability shape and must not be sent.
    expect(call.params[0].capabilities.paymasterService.policyId).toBeUndefined();
  });

  it("waitForCalls resolves confirmed from the EIP-5792 status code", async () => {
    const provider = providerWith({
      wallet_getCallsStatus: () => ({
        status: 200,
        receipts: [{ transactionHash: "0xdead" }],
      }),
    });
    const status = await waitForCalls(provider as any, "0xabc", 2000, 10);
    expect(status.status).toBe("confirmed");
    expect(status.hash).toBe("0xdead");
  });

  it("waitForCalls resolves failed from a non-200 status code", async () => {
    const provider = providerWith({ wallet_getCallsStatus: () => ({ status: 500 }) });
    const status = await waitForCalls(provider as any, "0xabc", 2000, 10);
    expect(status.status).toBe("failed");
  });
});

describe("gas capabilities (server config)", () => {
  const original = process.env.ALCHEMY_API_KEY;
  const originalPolicy = process.env.ALCHEMY_GAS_POLICY_ID;
  const restore = () => {
    if (original === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = original;
    if (originalPolicy === undefined) delete process.env.ALCHEMY_GAS_POLICY_ID;
    else process.env.ALCHEMY_GAS_POLICY_ID = originalPolicy;
  };

  it("reports public RPC and no sponsorship when unconfigured", () => {
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.ALCHEMY_GAS_POLICY_ID;
    const caps = gasCapabilities("mainnet");
    expect(caps.rpc).toBe("public");
    expect(caps.sponsorshipConfigured).toBe(false);
    restore();
  });

  it("requires both a key and a policy for sponsorship", () => {
    process.env.ALCHEMY_API_KEY = "k";
    delete process.env.ALCHEMY_GAS_POLICY_ID;
    expect(gasCapabilities("mainnet").sponsorshipConfigured).toBe(false);
    process.env.ALCHEMY_GAS_POLICY_ID = "pol";
    const caps = gasCapabilities("mainnet");
    expect(caps.rpc).toBe("alchemy");
    expect(caps.sponsorshipConfigured).toBe(true);
    expect(caps.policyId).toBe("pol");
    restore();
  });
});

describe("gas mode resolution (0-MON case)", () => {
  it("is native when neither a paymaster nor an ERC-20-gas wallet is available", () => {
    expect(resolveGasMode(false, false, false)).toBe("native");
  });

  it("does not claim sponsored merely because a paymaster is configured", () => {
    // Configured paymaster, but the wallet does not advertise support → native.
    expect(resolveGasMode(true, false, false)).toBe("native");
  });

  it("is sponsored only when a paymaster is configured AND the wallet supports it", () => {
    expect(resolveGasMode(true, true, false)).toBe("sponsored");
  });

  it("is erc20 when the wallet pays gas in a token but no paymaster is configured", () => {
    expect(resolveGasMode(false, false, true)).toBe("erc20");
    // Paymaster capability alone (wallet) without server config stays native.
    expect(resolveGasMode(false, true, false)).toBe("native");
  });

  it("builds the Alchemy Monad paymaster service URL", () => {
    expect(alchemyPaymasterServiceUrl("abc")).toBe(
      "https://monad-mainnet.g.alchemy.com/v2/abc",
    );
  });
});
