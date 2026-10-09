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

let aaCapabilityValue: any = null;
vi.mock("@/lib/hooks/useAaCapability", () => ({
  useAaCapability: () => ({ capability: aaCapabilityValue }),
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

let executePlanViaAa: any;
let checkUserOperationReceipt: any;
vi.mock("@/lib/aa/execution", async () => {
  const actual = await vi.importActual<any>("@/lib/aa/execution");
  executePlanViaAa = vi.fn();
  checkUserOperationReceipt = vi.fn();
  return {
    ...actual,
    executePlanViaAa: (...a: unknown[]) => executePlanViaAa(...a),
    checkUserOperationReceipt: (...a: unknown[]) => checkUserOperationReceipt(...a),
  };
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
    executePlanViaAa.mockReset();
    checkUserOperationReceipt.mockReset();
    aaCapabilityValue = null;
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

  it("shows an ERC-20 gas offer, not a MON demand, for a 0-MON wallet when abstraction is available", async () => {
    // The reported bug: 0 MON + USDC, gas abstraction configured, but the
    // composer printed "You need a small amount of MON for network fees … Your
    // wallet needs MON" while advertising ERC-20 gas. With an ERC-20 path
    // offered, the warning must NOT demand MON.
    baseFlow({
      readiness: { ready: false, code: "insufficient_gas", cta: "Not enough MON for network fee", severity: "error" },
      // The flow resolved a genuinely offered ERC-20 path for this payment.
      abstraction: {
        state: "INSUFFICIENT_TOKEN_BALANCE",
        abstracted: false,
        gasOptions: { native: true, sponsored: false, erc20GasPayment: true },
        message: "Best available gas token: WMON.",
      },
      gasSufficiency: { status: "insufficient", requiredMon: "0.01212", availableMon: "0" },
    });

    renderComposer();
    // The honest warning names the real blocker and does not assert MON is needed.
    expect(screen.queryByText(/Your wallet needs MON/)).toBeNull();
    expect(screen.queryByText(/Your wallet holds 0 MON/)).toBeNull();
    expect(screen.getByText(/Best available gas token: WMON/)).toBeTruthy();
  });

  it("keeps Review and the payment intent when paymaster preparation fails (no premature reset)", async () => {
    baseFlow({
      walletCaps: { atomicBatch: false, paymasterService: false, erc20GasPayment: false },
      gasMode: "erc20",
      gasInfo: {
        mode: "erc20",
        paymasterConfigured: true,
        walletSupportsPaymaster: false,
        walletSupportsErc20Gas: true,
        erc20GasToken: { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" },
      },
    });
    prepareSigning.mockResolvedValue({
      ok: true,
      plan: { executable: true, primaryStepId: "transfer", slippageBps: 50, steps: [
        {
          id: "transfer",
          kind: "transfer",
          label: "Send USDC",
          token: { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", symbol: "USDC" },
          to: flow.intent.recipient,
          amount: 300_000n,
        },
      ] },
      quote: { receiveAmount: "0.3" },
      receiveToken: "USDC",
      expectedReceive: "0.3",
      partial: false,
      gasMode: "erc20",
      version: flow.intent.version,
      key: flow.intent.key,
    });
    // The paymaster quote succeeded, but operation preparation failed.
    executePlanViaAa.mockRejectedValue(new Error("The paymaster did not return a quote."));

    renderComposer();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });

    // Still on Review with a real error — never ejected to a blank composer.
    expect(screen.queryByText("Review Payment")).toBeNull();
    // Recipient/amount/asset preserved across the recoverable failure.
    expect(flow.intent.recipient).toBe("0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4");
    expect(flow.intent.receiveAmount).toBe("5");
    expect(flow.intent.receiveToken).toBe("USDC");
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

  it("does NOT disappear after the wrap/approval step while the swap is still pending (MON → USDT)", async () => {
    // The reported MON→USDT symptom: the composer vanished right after the
    // wrap/approval. Cause: a mid-execution quote re-price (the quote clears and
    // the intent version bumps) unmounted the whole Review/executing subtree —
    // and the composer only rendered while a quote was held. Here the payment is
    // mid-flight and the quote clears underneath it; the composer must stay
    // mounted showing the in-progress steps, and must never fall back to the
    // composer's Review CTA.
    baseFlow({ walletCaps: { atomicBatch: true, paymasterService: false, erc20GasPayment: false } });
    prepareSigning.mockResolvedValue({
      ok: true,
      plan: {
        executable: true,
        primaryStepId: "swap",
        slippageBps: 50,
        steps: [
          { id: "wrap", kind: "wrap", label: "Wrap MON for the route", amount: 20_520_000_000_000_000_000n },
          {
            id: "approve",
            kind: "approve",
            label: "Approve up to 20.52 MON for the route",
            token: { address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", symbol: "WMON" },
            spender: "0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900",
            amount: 20_520_000_000_000_000_000n,
          },
          {
            id: "swap",
            kind: "swap",
            direction: "exact_in",
            label: "Convert MON → USDT",
            tokens: ["0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", "0xe7cd86e13AC4309349F30B3435a9d337750fC82D"],
            fees: [3000],
            amountIn: 20_520_000_000_000_000_000n,
            limit: 490_000n,
            recipient: flow.intent.recipient,
          },
        ],
      },
      quote: { receiveAmount: "0.5" },
      receiveToken: "USDT",
      expectedReceive: "0.5",
      partial: false,
      gasMode: "native",
      version: flow.intent.version,
      key: flow.intent.key,
    });
    // The batch is still confirming the swap when the quote re-prices underneath.
    let resolveBatch: (v: any) => void = () => {};
    executePlanBatched.mockImplementation(async (_p: any, _pr: any, _s: any, _c: any, _n: any, _o: any, cb: any) => {
      // Wrap landed; approve submitted; swap still pending — the moment the
      // reported composer-disappearance occurred.
      cb?.onStep?.({ stepId: "wrap", label: "Wrap MON for the route", status: "confirmed", hash: "0x1" });
      cb?.onStep?.({ stepId: "approve", label: "Approve up to 20.52 MON for the route", status: "confirmed", hash: "0x2" });
      cb?.onStep?.({ stepId: "swap", label: "Convert MON → USDT", status: "submitted", hash: "0x3" });
      return new Promise((resolve) => {
        resolveBatch = resolve;
      });
    });

    const { rerender } = renderComposer();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });

    // In-flight: the "Waiting for confirmation…" surface is mounted.
    expect(screen.getByText(/Waiting for confirmation/i)).toBeTruthy();

    // Mid-flight the quote clears and the intent version bumps (an engine
    // re-price). Previously this unmounted the composer entirely.
    flow.quote = null;
    flow.quoteVersion = 0;
    flow.quoting = false;
    flow.intent = reduceIntent(flow.intent, {
      payToken: "MON",
      receiveToken: "USDT",
      receiveAmount: "0.5",
    });
    await act(async () => {
      rerender(<PaymentComposer networkLabel="Monad" />);
    });

    // The composer did not disappear: the in-flight payment is still visible and
    // we are NOT back at the composer's Review CTA.
    expect(screen.getByText(/Waiting for confirmation/i)).toBeTruthy();
    expect(screen.queryByText("Review Payment")).toBeNull();

    // The swap fails after the wrap/approval (the reported moment). The catch
    // returns to Review — but the quote has been cleared by the re-price above,
    // so the pre-fix `stage === "review" && flow.quote` gate would render
    // NOTHING ("the payment composer disappeared"). The retained last quote must
    // keep Review mounted with a recoverable error.
    const { ExecutionError } = await vi.importActual<any>("@/lib/execution/execute");
    await act(async () => {
      resolveBatch(Promise.reject(new ExecutionError("The payment did not confirm on Monad.", "submitted")));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Still on Review, not blank, not back at the composer CTA.
    expect(screen.queryByText("Review Payment")).toBeNull();
    expect(screen.getByText(/Review payment/)).toBeTruthy();
    expect(screen.getByText(/did not confirm/i)).toBeTruthy();
  });

  it("prepares and submits via the ERC-20 paymaster path when the wallet holds only USDC and 0 MON", async () => {
    const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
    // The exact production shape: a token selected to pay gas (zero MON held).
    const gasTokenView = {
      chainId: 143,
      address: USDC,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      held: true,
      balance: "100",
      sufficientBalance: true,
      quoteKnown: true,
      estimatedFee: "0.012",
      estimatedFeeUsd: "0.012",
      selected: true,
    };
    aaCapabilityValue = {
      ok: true,
      chainId: 143,
      walletAbstraction: {
        available: true,
        mode: "ERC20_PAYMASTER",
        code: "native_required",
        reason: "Best available gas token: USDC.",
        selectedGasToken: gasTokenView,
        supportedGasTokens: [gasTokenView],
      },
      supportedGasTokens: [gasTokenView],
    };
    baseFlow({
      gasMode: "erc20",
      gasInfo: {
        mode: "erc20",
        paymasterConfigured: true,
        walletSupportsPaymaster: false,
        walletSupportsErc20Gas: true,
        erc20GasToken: { symbol: "USDC", address: USDC },
        reason: null,
      },
      aaGas: { available: true, mode: "ERC20_PAYMASTER", tokenSymbol: "USDC", tokenAddress: USDC, code: "native_required", reason: "Best available gas token: USDC." },
    });
    prepareSigning.mockResolvedValue({
      ok: true,
      plan: {
        executable: true,
        primaryStepId: "transfer",
        slippageBps: 50,
        steps: [
          {
            id: "transfer",
            kind: "transfer",
            label: "Send USDC",
            token: { address: USDC, symbol: "USDC" },
            amount: 300_000n,
            recipient: flow.intent.recipient,
          },
        ],
      },
      quote: { receiveAmount: "5" },
      receiveToken: "USDC",
      expectedReceive: "5",
      partial: false,
      gasMode: "erc20",
      version: flow.intent.version,
      key: flow.intent.key,
    });
    executePlanViaAa.mockResolvedValue({
      userOpHash: "0xop",
      transactionHash: "0xreceipt",
      success: true,
      logs: [],
    });

    renderComposer();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The ERC-20 path (not the sequential EOA path) was used, and it was asked
    // to bound the allowance against the real USDC balance.
    expect(executePlanViaAa).toHaveBeenCalledTimes(1);
    const args = executePlanViaAa.mock.calls[0];
    expect(args[4]).toBe(USDC); // gas token
    expect(args[7]).toBe(100_000_000n); // gas-token balance, base units
    expect(executePlan).not.toHaveBeenCalled();
  });

  it("honest fallback: when gas is native the ERC-20 path is never attempted", async () => {
    baseFlow({ gasMode: "native" });
    prepareSigning.mockResolvedValue({
      ok: true,
      plan: {
        executable: true,
        primaryStepId: "transfer",
        slippageBps: 50,
        steps: [
          {
            id: "transfer",
            kind: "transfer",
            label: "Send USDC",
            token: { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", symbol: "USDC" },
            amount: 300_000n,
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
    executePlan.mockResolvedValue({ primaryHash: "0xdead", results: [] });

    renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(executePlanViaAa).not.toHaveBeenCalled();
    expect(executePlan).toHaveBeenCalledTimes(1);
  });

  const USDC_ADDR = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

  /** Set up a zero-MON USDC transfer that selected the ERC-20 paymaster. */
  function erc20TransferSetup() {
    const gasTokenView = {
      chainId: 143,
      address: USDC_ADDR,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      held: true,
      balance: "100",
      sufficientBalance: true,
      quoteKnown: true,
      estimatedFee: "0.012",
      estimatedFeeUsd: "0.012",
      selected: true,
    };
    aaCapabilityValue = {
      ok: true,
      chainId: 143,
      walletAbstraction: {
        available: true,
        mode: "ERC20_PAYMASTER",
        code: "native_required",
        reason: "Best available gas token: USDC.",
        selectedGasToken: gasTokenView,
        supportedGasTokens: [gasTokenView],
      },
      supportedGasTokens: [gasTokenView],
    };
    baseFlow({
      gasMode: "erc20",
      gasInfo: {
        mode: "erc20",
        paymasterConfigured: true,
        walletSupportsPaymaster: false,
        walletSupportsErc20Gas: true,
        erc20GasToken: { symbol: "USDC", address: USDC_ADDR },
        reason: null,
      },
      aaGas: {
        available: true,
        mode: "ERC20_PAYMASTER",
        tokenSymbol: "USDC",
        tokenAddress: USDC_ADDR,
        code: "native_required",
        reason: "Best available gas token: USDC.",
      },
    });
    prepareSigning.mockResolvedValue({
      ok: true,
      plan: {
        executable: true,
        primaryStepId: "transfer",
        slippageBps: 50,
        steps: [
          {
            id: "transfer",
            kind: "transfer",
            label: "Send USDC",
            token: { address: USDC_ADDR, symbol: "USDC" },
            amount: 300_000n,
            recipient: flow.intent.recipient,
          },
        ],
      },
      quote: { receiveAmount: "5" },
      receiveToken: "USDC",
      expectedReceive: "5",
      partial: false,
      gasMode: "erc20",
      version: flow.intent.version,
      key: flow.intent.key,
    });
  }

  it("keeps Review and does not resubmit when the UserOperation is submitted but unconfirmed", async () => {
    erc20TransferSetup();
    // The user approved; the op was submitted, but the receipt timed out. This
    // previously left the user looping on "Waiting for confirmation…" with no
    // truthful outcome — and risked resubmitting (double-spending) on Retry.
    executePlanViaAa.mockResolvedValue({
      userOpHash: "0xop",
      success: false,
      unconfirmed: true,
      logs: [],
      reason: "The transaction was submitted but not confirmed yet.",
    });

    renderComposer();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Back on Review with an honest, recoverable message — never a success, and
    // never still stuck on the executing screen.
    expect(screen.getByText(/submitted but Monad hasn't confirmed/i)).toBeTruthy();
    expect(screen.queryByText(/Payment sent/i)).toBeNull();
    expect(screen.queryByText(/Waiting for confirmation/i)).toBeNull();
    expect(executePlanViaAa).toHaveBeenCalledTimes(1);

    // Retry must re-check the submitted hash's status, NOT resubmit it.
    checkUserOperationReceipt.mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.click(screen.getByText("Retry payment"));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(executePlanViaAa).toHaveBeenCalledTimes(1); // no duplicate submission
    expect(checkUserOperationReceipt).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/still awaiting confirmation/i)).toBeTruthy();
  });

  it("resolves a pending UserOperation to success on Retry without resubmitting", async () => {
    erc20TransferSetup();
    executePlanViaAa.mockResolvedValue({
      userOpHash: "0xop",
      success: false,
      unconfirmed: true,
      logs: [],
      reason: "The transaction was submitted but not confirmed yet.",
    });

    renderComposer();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The op confirms before the user retries: Retry adopts the confirmed
    // receipt and shows success — still without a second submission.
    checkUserOperationReceipt.mockResolvedValue({
      userOpHash: "0xop",
      transactionHash: "0xreceipt",
      success: true,
      logs: [],
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Retry payment"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(executePlanViaAa).toHaveBeenCalledTimes(1);
    expect(checkUserOperationReceipt).toHaveBeenCalledTimes(1);
    // The pending op resolved: the user is no longer stuck or told it is still
    // awaiting confirmation, and no second submission was made. (The success
    // subtree itself sits behind AnimatePresence `mode="wait"`, whose exit
    // animation does not settle reliably under jsdom, so it is asserted via the
    // cleared pending/error state rather than the animated child.)
    expect(screen.queryByText(/Waiting for confirmation/i)).toBeNull();
    expect(screen.queryByText(/still awaiting confirmation/i)).toBeNull();
    expect(screen.queryByText(/submitted but Monad hasn't confirmed/i)).toBeNull();
  });
});