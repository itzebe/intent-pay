// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// framer-motion's exit animations keep React's act() pending; render plain
// elements instead. The flow logic under test is independent of the animation.
vi.mock("framer-motion", () => {
  const strip = (props: Record<string, any>) => {
    const { initial, animate, exit, transition, variants, whileHover, whileTap, layout, ...rest } = props;
    return rest;
  };
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef((props: any, ref: any) =>
          React.createElement(tag, { ...strip(props), ref }),
        ),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: any) => React.createElement(React.Fragment, null, children),
  };
});

// ---------------------------------------------------------------------------
// The confirmation-loop reproduction.
//
// We drive the REAL PaymentComposer + ReviewSheet through Review -> Confirm and
// observe what the stage does when `prepareSigning` refuses (a recoverable
// safety block). The bug: a quote refresh that bumps the intent version while
// the user is on Review silently drops them back to the composer, so the same
// "Confirm" click has to be repeated forever.
// ---------------------------------------------------------------------------

const flow: any = {};

vi.mock("@/lib/hooks/usePayment", () => ({
  usePaymentFlow: () => flow,
}));

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const STABLE_PROVIDER = { request: vi.fn() };
const STABLE_WALLET_CLIENT = { account: { address: SENDER } };
const ensureMonad = vi.fn(async () => true);

vi.mock("@/lib/hooks/useWallet", () => ({
  // Stable references: the composer keys effects on `provider`/`walletClient`,
  // and a fresh object per render would re-run them indefinitely.
  useWallet: () => ({
    status: "connected",
    address: SENDER,
    hasProvider: true,
    provider: STABLE_PROVIDER,
    walletClient: STABLE_WALLET_CLIENT,
    ensureMonad,
  }),
}));

vi.mock("@/lib/hooks/useTokenCatalog", () => ({
  useTokenCatalog: () => ({ tokens: [], info: null, loading: false, error: null }),
}));

vi.mock("@/lib/hooks/useAaCapability", () => ({
  useAaCapability: () => ({ capability: null }),
}));

// Stub the heavy presentational children so the test only exercises the flow.
vi.mock("@/components/composer/IntentEngine", () => ({ IntentEngine: () => null }));
vi.mock("@/components/flow/FlowDiagram", () => ({ FlowDiagram: () => null }));
vi.mock("@/components/success/SuccessScreen", () => ({ SuccessScreen: () => null }));
vi.mock("@/components/wallet/WalletBar", () => ({
  BalanceOverview: () => null,
  ConnectButton: () => null,
}));
vi.mock("@/components/ui/TokenList", () => ({ TokenList: () => null }));
vi.mock("@/components/ui/Modal", () => ({ Modal: () => null }));
vi.mock("@/components/composer/RecipientField", () => ({ RecipientField: () => null }));
vi.mock("@/components/composer/AmountField", () => ({ AmountField: () => null }));
vi.mock("@/components/composer/PayAssetPicker", () => ({ PayAssetPicker: () => null }));
vi.mock("@/components/composer/ModeToggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/composer/MismatchAlert", () => ({ MismatchAlert: () => null }));
vi.mock("@/components/composer/LiveCalculation", () => ({ LiveCalculation: () => null }));

vi.mock("@/lib/execution/alchemy", async () => {
  const actual = await vi.importActual<any>("@/lib/execution/alchemy");
  return {
    ...actual,
    getWalletCapabilities: vi.fn(async () => ({
      atomicBatch: true,
      paymasterService: false,
      erc20GasPayment: false,
    })),
  };
});
vi.mock("@/lib/aa/account", () => ({ walletSupportsEip7702: vi.fn(async () => false) }));
vi.mock("@/lib/wallet/clients", () => ({ getClientPublicClient: () => ({}) }));

const prepareSigning = vi.fn();
vi.mock("@/lib/execution/signGuard", async () => {
  const actual = await vi.importActual<any>("@/lib/execution/signGuard");
  return { ...actual, prepareSigning: (...a: unknown[]) => prepareSigning(...a) };
});

const executePlan = vi.fn();
const executePlanBatched = vi.fn();
vi.mock("@/lib/execution/execute", async () => {
  const actual = await vi.importActual<any>("@/lib/execution/execute");
  return {
    ...actual,
    executePlan: (...a: unknown[]) => executePlan(...a),
    executePlanBatched: (...a: unknown[]) => executePlanBatched(...a),
  };
});

const { PaymentComposer } = await import("@/components/composer/PaymentComposer");
const { reduceIntent, initialIntent } = await import("@/lib/domain/canonicalIntent");

function makeQuote(version: number) {
  return {
    intent: {
      recipient: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
      receiveToken: "USDC",
      receiveAmount: "5",
      amountMode: "recipient_receives",
    },
    network: "mainnet",
    payToken: { symbol: "USDT", address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", decimals: 6, tint: "#000", name: "Tether" },
    receiveToken: { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6, tint: "#000", name: "USD Coin" },
    payAmount: "5",
    receiveAmount: "5",
    payUsd: 5,
    receiveUsd: 5,
    rate: 1,
    priceImpact: 0.001,
    route: { kind: "swap", hops: [], path: ["USDT", "USDC"] },
    totalSenderCostUsd: 5,
    networkCostUsd: 0.01,
    networkCostUsdAvailable: true,
    gasLimit: 200000n,
    gasPriceWei: 1000000000n,
    quotedAt: Date.now(),
    gas: { mode: "native", sponsorshipConfigured: false, rpc: "public" },
    __version: version,
  } as any;
}

function baseFlow(overrides: Record<string, unknown>) {
  const intent = reduceIntent(initialIntent(), {
    recipient: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
    receiveToken: "USDC",
    receiveAmount: "5",
    amountMode: "recipient_receives",
    payToken: "USDT",
    payTokenSource: "user",
  });
  Object.assign(flow, {
    intent,
    quote: makeQuote(intent.version),
    quoteVersion: intent.version,
    quoting: false,
    quoteError: null,
    quoteStale: false,
    autoRefreshAt: Date.now(),
    quoteRefreshFailedAt: 0,
    balances: [],
    balancesLoading: false,
    walletAccount: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
    recipientConfirmed: true,
    revalidationTick: 0,
    intendedReceiveAmount: "5",
    tokensVersion: 0,
    readiness: { ready: true, code: "ready", cta: "Review Payment", severity: "ok" },
    receiveTokenConfig: { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6, tint: "#000", name: "USD Coin" },
    payTokenConfig: { symbol: "USDT", address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", decimals: 6, tint: "#000", name: "Tether" },
    capabilities: null,
    optimizer: null,
    optimizerLoading: false,
    mismatch: null,
    sufficiency: { status: "ok", required: "5", available: "100", shortfall: "0" },
    gasSufficiency: { status: "ok", requiredMon: "0", availableMon: "100" },
    partial: null,
    gasMode: "native",
    gasInfo: { mode: "native", paymasterConfigured: false, walletSupportsPaymaster: false, walletSupportsErc20Gas: false, reason: null },
    abstraction: { state: "NATIVE_GAS_REQUIRED", abstracted: false, gasOptions: { native: true, sponsored: false, erc20GasPayment: false }, message: "" },
    aaGas: { available: false, mode: "NATIVE", reason: null, tokenSymbol: null, tokenAddress: null, code: null },
    gasTokenConfig: null,
    sourceSelection: { code: "auto", sourceAsset: "USDT", sourceAddress: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", reason: "best", blocker: null, pending: false },
    setWalletGasCapabilities: vi.fn(),
    setAaGas: vi.fn(),
    setGasPaymentToken: vi.fn(),
    refreshQuote: vi.fn(),
    setBalances: vi.fn(),
    setWalletAccount: vi.fn(),
    markRecipientConfirmed: vi.fn(),
    ...overrides,
  });
}

function renderComposer() {
  return render(<PaymentComposer networkLabel="Monad" />);
}

// The composer/flow hooks we do not mock issue relative fetches; jsdom has no
// server. Stub them so the effects settle deterministically.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, balances: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

describe("confirmation flow", () => {
  beforeEach(() => {
    prepareSigning.mockReset();
    executePlan.mockReset();
    executePlanBatched.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the recipient, amount and asset and does NOT return to the composer when a same-version quote refresh is in flight", async () => {
    baseFlow({});
    const { rerender } = renderComposer();

    // Enter Review.
    fireEvent.click(screen.getByText("Review Payment"));
    expect(screen.getByText(/Confirm & Send/)).toBeTruthy();

    // A same-version refresh begins: `flow.quote` is momentarily null while the
    // new quote is being fetched. This previously ejected the user back to the
    // composer ("previous screen") and restarted the cycle.
    flow.quote = null;
    flow.quoteVersion = 0;
    flow.quoting = true;
    flow.quoteStale = true;
    await act(async () => {
      rerender(<PaymentComposer networkLabel="Monad" />);
    });

    // Regression: still inside the payment flow — the composer's Review CTA must
    // not reappear, so the user can never be silently looped back.
    expect(screen.queryByText("Review Payment")).toBeNull();
    // The payment is preserved: the intent still names the recipient/asset/amount.
    expect(flow.intent.recipient).toBe("0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4");
    expect(flow.intent.receiveToken).toBe("USDC");
    expect(flow.intent.receiveAmount).toBe("5");
    expect(flow.intent.payToken).toBe("USDT");
  });

  it("shows a recoverable error with Retry and keeps review state when the guard refuses", async () => {
    baseFlow({});
    prepareSigning.mockResolvedValue({
      ok: false,
      reason: "quote_stale",
      message: "The price moved. We refreshed it — review the new price and confirm again.",
      expectedVersion: flow.intent.version,
      actualVersion: flow.intent.version,
    });

    renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      fireEvent.click(screen.getByText(/Confirm & Send/));
    });

    // Still on Review, with a clear error and a Retry action.
    expect(screen.getByText(/The price moved/i)).toBeTruthy();
    expect(screen.getByText("Retry payment")).toBeTruthy();
    expect(screen.queryByText("Review Payment")).toBeNull();
  });

  it("prevents duplicate submissions while an attempt is in progress", async () => {
    baseFlow({});
    // A slow preparation the user double-clicks through.
    prepareSigning.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: false,
                reason: "quote_stale",
                message: "The price moved. We refreshed it — review the new price and confirm again.",
                expectedVersion: flow.intent.version,
                actualVersion: flow.intent.version,
              }),
            50,
          );
        }),
    );

    renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));

    // Two rapid clicks on Confirm/Retry must run exactly one preparation.
    await act(async () => {
      const buttons = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(buttons[0]);
      fireEvent.click(buttons[0]);
    });

    expect(prepareSigning).toHaveBeenCalledTimes(1);
    expect(executePlan).not.toHaveBeenCalled();
    expect(executePlanBatched).not.toHaveBeenCalled();
  });

  it("does not submit a second transaction when a batched submission's outcome is ambiguous", async () => {
    baseFlow({ walletCaps: { atomicBatch: true, paymasterService: false, erc20GasPayment: false } });
    prepareSigning.mockResolvedValue({
      ok: true,
      plan: {
        executable: true,
        primaryStepId: "swap",
        slippageBps: 50,
        steps: [
          {
            id: "approve",
            kind: "approve",
            label: "Approve",
            token: { address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", symbol: "USDT" },
            spender: "0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900",
            amount: 5_000_000n,
          },
          {
            id: "swap",
            kind: "swap",
            direction: "exact_in",
            label: "Swap",
            tokens: [
              "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
              "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
            ],
            fees: [3000],
            amountIn: 5_000_000n,
            limit: 4_900_000n,
            recipient: flow.intent.recipient,
          },
        ],
      },
      quote: { receiveAmount: "5" },
      receiveToken: "USDC",
      expectedReceive: "5",
      partial: false,
      gasMode: "native",
      version: flow.intent.version,
      key: flow.intent.key,
    });
    // The batch produced a hash but did not confirm: an ambiguous submission.
    const { ExecutionError } = await vi.importActual<any>("@/lib/execution/execute");
    executePlanBatched.mockImplementation(async (_p: any, _pr: any, _s: any, _c: any, _n: any, _o: any, _cb: any) => {
      _cb?.onStep?.({ stepId: "swap", label: "Swap", status: "submitted", hash: "0xdead" });
      throw new ExecutionError("The payment did not confirm on Monad.", "submitted");
    });

    renderComposer();
    // Let the wallet-capability probe settle so the batch path is eligible.
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });

    // The ambiguous batch must NOT trigger a sequential re-submission.
    expect(executePlan).not.toHaveBeenCalled();
    // It returns to Review with an error, never a fabricated success.
    expect(screen.getByText(/did not confirm/i)).toBeTruthy();
  });

  it("keeps the user on Review when the engine re-prices a new version underneath them (the reported loop)", async () => {
    baseFlow({});
    const { rerender } = renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    expect(screen.getByText(/Confirm & Send/)).toBeTruthy();

    // While the user is reading Review, source selection re-picks the same
    // asset at a new version and clears the quote — the exact loop trigger.
    // Previously this ejected the user back to the composer (the endless loop).
    const bumped = reduceIntent(flow.intent, {
      payToken: "USDT",
      payTokenSource: "user",
      receiveToken: "USDC",
      receiveAmount: "6",
    });
    flow.intent = bumped;
    flow.quote = null;
    flow.quoteVersion = 0;
    flow.quoting = false;
    await act(async () => {
      rerender(<PaymentComposer networkLabel="Monad" />);
    });

    // Still inside the payment flow: the composer's Review CTA must NOT
    // reappear, and the payment is preserved across the re-price.
    expect(screen.queryByText("Review Payment")).toBeNull();
    expect(screen.getByText(/Review payment/)).toBeTruthy();
    expect(flow.intent.recipient).toBe("0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4");
    expect(flow.intent.receiveToken).toBe("USDC");
  });

  it("keeps rendering the payment (does not blank) when a refresh momentarily clears the quote", async () => {
    baseFlow({});
    const { rerender } = renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    expect(screen.getByText(/Confirm & Send/)).toBeTruthy();

    // A same-version refresh clears the quote and marks it quoting. Previously
    // the Review subtree required `flow.quote`, so it vanished mid-refresh.
    flow.quote = null;
    flow.quoteVersion = 0;
    flow.quoting = true;
    flow.quoteStale = true;
    await act(async () => {
      rerender(<PaymentComposer networkLabel="Monad" />);
    });

    // Review is still mounted (the last quote is shown) and Confirm is gated.
    expect(screen.queryByText("Review Payment")).toBeNull();
    expect(screen.getByText(/Review payment/)).toBeTruthy();
    expect(screen.getByText("Refreshing price…")).toBeTruthy();
  });
});