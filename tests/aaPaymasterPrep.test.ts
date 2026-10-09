import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erc20Paymaster } from "@/lib/aa/execution";
import { filterUserOperation } from "@/lib/aa/userOp";
import { createPimlicoProvider } from "@/lib/server/paymaster/pimlico";
import { POST as paymasterPOST } from "@/app/api/aa/paymaster/route";

/**
 * ERC-20 gas preparation regression suite.
 *
 * The production failure this pins: the paymaster proxy always called
 * `pm_getPaymasterData`, which Pimlico rejects before gas estimation with
 * "paymasterValidationGasLimit is required for erc20 mode". The correct stage
 * method is `pm_getPaymasterStubData`. A successful *quote* endpoint is not
 * proof of operation-level eligibility, so these tests drive the real
 * preparation path (client capability → server proxy → provider RPC).
 */

const TOKEN = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;
const PAYMASTER = "0x888888888888ec68a58ab8094cc1ad20ba3d2402";
const STUB_DATA = "0x0300deadbeef";

/** Capture every Pimlico JSON-RPC call and answer by method. */
function mockPimlico(behaviour: {
  supported?: unknown;
  stub?: unknown;
  data?: unknown;
}) {
  const calls: { method: string; params: any[] }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method: body.method, params: body.params });
    if (!String(url).includes("pimlico")) throw new Error(`unexpected fetch ${url}`);
    let result: unknown;
    let error: unknown;
    if (body.method === "pimlico_getSupportedTokens") {
      result = behaviour.supported ?? [{ token: TOKEN, symbol: "USDC", name: "USD Coin", decimals: 6 }];
    } else if (body.method === "pm_getPaymasterStubData") {
      result = behaviour.stub ?? { paymaster: PAYMASTER, paymasterData: STUB_DATA, paymasterPostOpGasLimit: "0x153ce" };
    } else if (body.method === "pm_getPaymasterData") {
      result = behaviour.data ?? { paymaster: PAYMASTER, paymasterData: STUB_DATA };
    } else if (body.method === "pimlico_getTokenQuotes") {
      result = { quotes: [{ paymaster: PAYMASTER, exchangeRate: "0x69cf", postOpGas: "0x907e", balanceSlot: "0xa", allowanceSlot: "0x9" }] };
    } else {
      error = { message: `unsupported ${body.method}` };
    }
    return {
      ok: true,
      status: 200,
      json: async () => (error ? { jsonrpc: "2.0", id: 1, error } : { jsonrpc: "2.0", id: 1, result }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** A minimal Response-like object for the Next route handler. */
function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/aa/paymaster", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let keyCounter = 0;
beforeEach(() => {
  keyCounter += 1;
  // Unique key per test so the module-level discovery cache cannot leak state.
  process.env.PIMLICO_API_KEY = `test-key-${keyCounter}-${Date.now()}`;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PIMLICO_API_KEY;
});

describe("UserOperation field filtering (EntryPoint v0.8)", () => {
  it("drops transport-only keys and the viem `authorization` name", () => {
    const filtered = filterUserOperation({
      sender: "0xabc",
      callData: "0x",
      chainId: 143,
      entryPointAddress: "0x000",
      context: { token: TOKEN },
      authorization: { address: "0ximpl", chainId: 143 },
    });
    expect(filtered.sender).toBe("0xabc");
    expect(filtered.chainId).toBeUndefined();
    expect(filtered.entryPointAddress).toBeUndefined();
    expect(filtered.context).toBeUndefined();
    // Pimlico rejects the viem transport name; the caller must fold it.
    expect(filtered.authorization).toBeUndefined();
  });

  it("keeps the EntryPoint v0.8 `eip7702Auth` field", () => {
    const auth = { address: "0ximpl", chainId: 143 };
    const filtered = filterUserOperation({ sender: "0xabc", eip7702Auth: auth });
    expect(filtered.eip7702Auth).toEqual(auth);
  });
});

describe("client paymaster capability (lib/aa/execution)", () => {
  it("requests the stub method for gas estimation and the data method for submission", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)).method);
        return { ok: true, json: async () => ({ ok: true, result: { paymaster: PAYMASTER, paymasterData: STUB_DATA } }) } as unknown as Response;
      }),
    );

    const pm = erc20Paymaster(TOKEN);
    await pm.getPaymasterStubData({ sender: "0xabc", chainId: 143, entryPointAddress: "0xEP" });
    await pm.getPaymasterData({ sender: "0xabc", chainId: 143, entryPointAddress: "0xEP" });

    expect(seen).toEqual(["pm_getPaymasterStubData", "pm_getPaymasterData"]);
  });

  it("forwards the 7702 authorization separately, never inside the userOperation", async () => {
    let sent: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return { ok: true, json: async () => ({ ok: true, result: { paymaster: PAYMASTER, paymasterData: STUB_DATA } }) } as unknown as Response;
      }),
    );
    const pm = erc20Paymaster(TOKEN);
    await pm.getPaymasterStubData({
      sender: "0xabc",
      chainId: 143,
      entryPointAddress: "0xEP",
      authorization: { address: "0ximpl", chainId: 143, nonce: 0 },
    });
    expect(sent.authorization).toEqual({ address: "0ximpl", chainId: 143, nonce: 0 });
    expect(sent.userOperation.authorization).toBeUndefined();
    expect(sent.userOperation.chainId).toBeUndefined();
  });

  it("throws a clear error when preparation fails (no silent MON fallback)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, message: "The paymaster did not return a quote." }) }) as unknown as Response),
    );
    const pm = erc20Paymaster(TOKEN);
    await expect(pm.getPaymasterStubData({ sender: "0xabc", entryPointAddress: "0xEP" })).rejects.toThrow(
      /did not return a quote/,
    );
  });
});

describe("provider quote stage selection (lib/server/paymaster/pimlico)", () => {
  it("uses the requested RPC method and returns the paymaster payload", async () => {
    const calls = mockPimlico({});
    const provider = createPimlicoProvider(process.env.PIMLICO_API_KEY);
    const token = { chainId: 143, address: TOKEN, symbol: "USDC", name: "USD Coin", decimals: 6 };

    const quote = await provider.quote({
      chainId: 143,
      entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
      token,
      userOperation: { sender: "0xabc", callGasLimit: "0x0" },
      method: "pm_getPaymasterStubData",
    });

    expect(quote).not.toBeNull();
    expect(quote!.paymaster.toLowerCase()).toBe(PAYMASTER);
    expect(quote!.paymasterData).toBe(STUB_DATA);
    expect(calls.some((c) => c.method === "pm_getPaymasterStubData")).toBe(true);
    expect(calls.some((c) => c.method === "pm_getPaymasterData")).toBe(false);
  });

  it("defaults to the stub method when none is specified", async () => {
    const calls = mockPimlico({});
    const provider = createPimlicoProvider(process.env.PIMLICO_API_KEY);
    await provider.quote({
      chainId: 143,
      entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
      token: { chainId: 143, address: TOKEN, symbol: "USDC", name: "USD Coin", decimals: 6 },
      userOperation: { sender: "0xabc" },
    });
    expect(calls.some((c) => c.method === "pm_getPaymasterStubData")).toBe(true);
  });

  it("returns null (honest fallback) when the provider rejects the operation", async () => {
    // Every paymaster call fails, so no quote may be claimed.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const result =
        body.method === "pimlico_getSupportedTokens"
          ? [{ token: TOKEN, symbol: "USDC", name: "USD Coin", decimals: 6 }]
          : undefined;
      return {
        ok: true,
        json: async () =>
          result
            ? { jsonrpc: "2.0", id: 1, result }
            : { jsonrpc: "2.0", id: 1, error: { message: "paymasterValidationGasLimit is required for erc20 mode" } },
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createPimlicoProvider(process.env.PIMLICO_API_KEY);
    const quote = await provider.quote({
      chainId: 143,
      entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
      token: { chainId: 143, address: TOKEN, symbol: "USDC", name: "USD Coin", decimals: 6 },
      userOperation: { sender: "0xabc" },
      method: "pm_getPaymasterData",
    });
    expect(quote).toBeNull();
  });
});

describe("server proxy /api/aa/paymaster — operation preparation", () => {
  it("forwards the client's requested method (stub), folds eip7702Auth and defaults gas fields", async () => {
    const calls = mockPimlico({});
    const res = await paymasterPOST(
      jsonRequest({
        method: "pm_getPaymasterStubData",
        token: TOKEN,
        entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
        authorization: { address: "0ximpl", chainId: 143 },
        userOperation: {
          sender: "0xabc",
          callData: "0x",
          // transport-only keys that must be dropped
          chainId: 143,
          entryPointAddress: "0xEP",
          context: {},
        },
      }),
    );
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.result.paymaster.toLowerCase()).toBe(PAYMASTER);
    const stubCall = calls.find((c) => c.method === "pm_getPaymasterStubData");
    expect(stubCall, "the stub method must be used for estimation").toBeTruthy();
    const op = stubCall!.params[0];
    expect(op.chainId).toBeUndefined();
    expect(op.context).toBeUndefined();
    expect(op.eip7702Auth).toEqual({ address: "0ximpl", chainId: 143 });
    expect(op.authorization).toBeUndefined();
    // Pimlico requires the not-yet-estimated gas fields present, defaulted to 0x0.
    expect(op.callGasLimit).toBe("0x0");
    expect(op.verificationGasLimit).toBe("0x0");
    expect(op.preVerificationGas).toBe("0x0");
  });

  it("honours pm_getPaymasterData when the client requests it (submission stage)", async () => {
    const calls = mockPimlico({});
    const res = await paymasterPOST(
      jsonRequest({
        method: "pm_getPaymasterData",
        token: TOKEN,
        entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
        userOperation: { sender: "0xabc", callGasLimit: "0x1", verificationGasLimit: "0x1", preVerificationGas: "0x1", paymasterVerificationGasLimit: "0x1" },
      }),
    );
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(calls.some((c) => c.method === "pm_getPaymasterData")).toBe(true);
    expect(calls.some((c) => c.method === "pm_getPaymasterStubData")).toBe(false);
  });

  it("refuses a token the live provider does not support (no fabricated support)", async () => {
    mockPimlico({ supported: [{ token: TOKEN, symbol: "USDC", name: "USD Coin", decimals: 6 }] });
    const res = await paymasterPOST(
      jsonRequest({
        method: "pm_getPaymasterStubData",
        token: "0x1111111111111111111111111111111111111111",
        entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
        userOperation: { sender: "0xabc" },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.message).toMatch(/doesn't accept/i);
  });

  it("answers a preparation failure honestly (502, real reason) rather than claiming MON is required", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const result =
        body.method === "pimlico_getSupportedTokens"
          ? [{ token: TOKEN, symbol: "USDC", name: "USD Coin", decimals: 6 }]
          : undefined;
      return {
        ok: true,
        json: async () =>
          result
            ? { jsonrpc: "2.0", id: 1, result }
            : { jsonrpc: "2.0", id: 1, error: { message: "AA50 PostOp Reverted" } },
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await paymasterPOST(
      jsonRequest({
        method: "pm_getPaymasterStubData",
        token: TOKEN,
        entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
        userOperation: { sender: "0xabc" },
      }),
    );
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.message).toMatch(/did not return a quote/i);
  });
});
