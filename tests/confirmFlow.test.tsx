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
//
// Execution is now the standard EOA path (gas paid in MON); the abandoned
// EIP-7702 / paymaster / EIP-5792 batch machinery is no longer part of the
// product, so those paths are not exercised here.
// ---------------------------------------------------------------------------

const flow: any = {};

vi.mock("@/lib/hooks/usePayment", () => ({
  usePaymentFlow: () => flow,
}));

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const STABLE_PROVIDER = { request: vi.fn() };
const STABLE_WALLET_CLIENT = { account: { address: SENDER } };
const ensureMonad = vi.fn(
  async (): Promise<{ ok: true } | { ok: false; error: { kind: string; rejected: boolean; message: string; code?: number } }> =>
    ({ ok: true }),
);

vi.mock("@/lib/hooks/useWallet", () => ({
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

vi.mock("@/lib/wallet/clients", () => ({ getClientPublicClient: () => ({}) }));

const prepareSigning = vi.fn();
vi.mock("@/lib/execution/signGuard", async () => {
  const actual = await vi.importActual<any>("@/lib/execution/signGuard");
  return { ...actual, prepareSigning: (...a: unknown[]) => prepareSigning(...a) };
});

const executePlan = vi.fn();
vi.mock("@/lib/execution/execute", async () => {
  const actual = await vi.importActual<any>("@/lib/execution/execute");
  return {
    ...actual,
    executePlan: (...a: unknown[]) => executePlan(...a),
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
    gas: { mode: "native", rpc: "public" },
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
    gasInfo: { mode: "native", reason: null },
    sourceSelection: { code: "auto", sourceAsset: "USDT", sourceAddress: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", reason: "best", blocker: null, pending: false },
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
    // Default: already on Monad. Individual tests override to exercise the
    // honest chain-error path, then this restores the default.
    ensureMonad.mockReset();
    ensureMonad.mockResolvedValue({ ok: true } as const);
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the recipient, amount and asset and does NOT return to the composer when a same-version quote refresh is in flight", async () => {
    baseFlow({});
    const { rerender } = renderComposer();

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

    expect(screen.queryByText("Review Payment")).toBeNull();
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

    expect(screen.getByText(/The price moved/i)).toBeTruthy();
    expect(screen.getByText("Retry payment")).toBeTruthy();
    expect(screen.queryByText("Review Payment")).toBeNull();
  });

  it("shows a MON network-fee explanation, never an ERC-20 gas offer, for a 0-MON wallet", async () => {
    // Gas is always paid in MON now. A wallet holding tokens but no MON must be
    // told, plainly and specifically, that it needs enough MON for the fee —
    // there is no gas-in-token path any more, and no misleading precision.
    baseFlow({
      readiness: { ready: false, code: "insufficient_gas", cta: "Not enough MON for network fee", severity: "error" },
      gasSufficiency: { status: "insufficient", requiredMon: "0.01212", availableMon: "0" },
    });

    renderComposer();
    expect(screen.getByText(/Insufficient MON for network fees/i)).toBeTruthy();
    expect(screen.getByText(/also need enough MON to cover the transaction fee/i)).toBeTruthy();
    // And there is no promised token-gas path.
    expect(screen.queryByText(/Sponsored/i)).toBeNull();
  });

  it("prevents duplicate submissions while an attempt is in progress", async () => {
    baseFlow({});
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

    await act(async () => {
      const buttons = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(buttons[0]);
      fireEvent.click(buttons[0]);
    });

    expect(prepareSigning).toHaveBeenCalledTimes(1);
    expect(executePlan).not.toHaveBeenCalled();
  });

  it("keeps the user on Review when the engine re-prices a new version underneath them (the reported loop)", async () => {
    baseFlow({});
    const { rerender } = renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    expect(screen.getByText(/Confirm & Send/)).toBeTruthy();

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

    flow.quote = null;
    flow.quoteVersion = 0;
    flow.quoting = true;
    flow.quoteStale = true;
    await act(async () => {
      rerender(<PaymentComposer networkLabel="Monad" />);
    });

    expect(screen.queryByText("Review Payment")).toBeNull();
    expect(screen.getByText(/Review payment/)).toBeTruthy();
    expect(screen.getByText("Refreshing price…")).toBeTruthy();
  });

  it("does NOT disappear after the wrap/approval step while the swap is still pending (MON → USDT)", async () => {
    // The reported MON→USDT symptom: the composer vanished right after the
    // wrap/approval. Cause: a mid-execution quote re-price unmounted the whole
    // Review/executing subtree. Here the payment is mid-flight and the quote
    // clears underneath it; the composer must stay mounted and must never fall
    // back to the composer's Review CTA.
    baseFlow({});
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
    let rejectRun: (e: unknown) => void = () => {};
    executePlan.mockImplementation(async (_p: any, _w: any, _n: any, cb: any) => {
      cb?.onStep?.({ stepId: "wrap", label: "Wrap MON for the route", status: "confirmed", hash: "0x1" });
      cb?.onStep?.({ stepId: "approve", label: "Approve up to 20.52 MON for the route", status: "confirmed", hash: "0x2" });
      cb?.onStep?.({ stepId: "swap", label: "Convert MON → USDT", status: "submitted", hash: "0x3" });
      return new Promise((_resolve, reject) => {
        rejectRun = reject;
      });
    });

    const { rerender } = renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });

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

    expect(screen.getByText(/Waiting for confirmation/i)).toBeTruthy();
    expect(screen.queryByText("Review Payment")).toBeNull();

    const { ExecutionError } = await vi.importActual<any>("@/lib/execution/execute");
    await act(async () => {
      rejectRun(new ExecutionError("The payment did not confirm on Monad.", "submitted"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("Review Payment")).toBeNull();
    expect(screen.getByText(/Review payment/)).toBeTruthy();
    // The ambiguous post-submission failure is surfaced as an honest,
    // actionable message (never the raw provider string).
    expect(screen.getByText(/could not confirm whether the transaction/i)).toBeTruthy();
  });

  it("submits through the standard EOA path with gas paid in MON", async () => {
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

    expect(executePlan).toHaveBeenCalledTimes(1);
    // The wallet client that signs is the connected EOA wallet client.
    expect(executePlan.mock.calls[0][1]).toBe(STABLE_WALLET_CLIENT);
  });

  it("surfaces the wallet's real chain-switch rejection and never silently resets", async () => {
    baseFlow({});
    ensureMonad.mockResolvedValue({
      ok: false,
      error: { kind: "rejected", code: 4001, rejected: true, message: "You rejected the request in your wallet. Nothing was sent." },
    });

    renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/You rejected the request in your wallet/i)).toBeTruthy();
    expect(screen.queryByText("Review Payment")).toBeNull();
    expect(flow.intent.recipient).toBe("0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4");
    expect(flow.intent.receiveAmount).toBe("5");
    expect(flow.intent.receiveToken).toBe("USDC");
    expect(screen.queryByText(/Waiting for confirmation/i)).toBeNull();
    expect(prepareSigning).not.toHaveBeenCalled();
    expect(executePlan).not.toHaveBeenCalled();
  });

  it("differentiates an unsupported chain switch from a rejection", async () => {
    baseFlow({});
    ensureMonad.mockResolvedValue({
      ok: false,
      error: { kind: "unsupported", code: 4200, rejected: false, message: "Your wallet doesn't support this request. Update it or use a wallet that does, then try again." },
    });

    renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/doesn't support this request/i)).toBeTruthy();
    expect(screen.queryByText(/Please switch your wallet to Monad/i)).toBeNull();
    expect(screen.queryByText("Review Payment")).toBeNull();
  });

  it("keeps Review and the intent when prepareSigning blocks on account change", async () => {
    baseFlow({});
    prepareSigning.mockResolvedValue({
      ok: false,
      reason: "account_changed",
      message: "Your wallet account changed. Balances and gas were rebuilt for the new account — review and confirm again.",
      expectedVersion: flow.intent.version,
      actualVersion: flow.intent.version,
    });

    renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/account changed/i)).toBeTruthy();
    expect(screen.getByText("Retry payment")).toBeTruthy();
    expect(screen.queryByText("Review Payment")).toBeNull();
    expect(flow.intent.receiveAmount).toBe("5");
  });

  it("does not report success when delivery verification cannot prove the receipt", async () => {
    baseFlow({});
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

    // Exactly one submission and no double-spend.
    expect(executePlan).toHaveBeenCalledTimes(1);
  });

  it("never reports success for an unconfirmed (unobserved-receipt) submission", async () => {
    baseFlow({});
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
    // A broadcast transaction whose receipt was not observed in time.
    executePlan.mockResolvedValue({
      primaryHash: "0xpending",
      confirmed: false,
      results: [
        { stepId: "transfer", label: "Send USDC", status: "submitted", unconfirmed: true, hash: "0xpending" },
      ],
    });

    renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The honest unknown-outcome screen is shown — not a success screen.
    expect(screen.getByText(/Transaction status unknown/i)).toBeTruthy();
    expect(screen.queryByText(/Waiting for confirmation/i)).toBeNull();
    // Exactly one submission and no automatic resubmission.
    expect(executePlan).toHaveBeenCalledTimes(1);
  });

  it("maps a raw provider error to an actionable message on Review", async () => {
    baseFlow({});
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
    executePlan.mockRejectedValue(new Error("insufficient funds for gas * price + value"));

    renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The raw provider string never reaches the user; the specific, actionable
    // MON-for-fees guidance does.
    expect(screen.getByText(/Insufficient MON for network fees/i)).toBeTruthy();
    expect(screen.getByText(/Reduce the transfer amount or add MON to your wallet/i)).toBeTruthy();
    expect(screen.queryByText(/gas \* price/i)).toBeNull();
  });

  it("lets the user recover from the unknown-outcome screen (no dead-end)", async () => {
    baseFlow({});
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
    executePlan.mockResolvedValue({
      primaryHash: "0xpending",
      confirmed: false,
      results: [
        { stepId: "transfer", label: "Send USDC", status: "submitted", unconfirmed: true, hash: "0xpending" },
      ],
    });

    renderComposer();
    fireEvent.click(screen.getByText("Review Payment"));
    await act(async () => {
      const [confirm] = screen.getAllByText(/Confirm & Send/);
      fireEvent.click(confirm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/Transaction status unknown/i)).toBeTruthy();

    // "Back to edit" returns the user to a working composer — not a blank or
    // trapped state — and preserves the payment they were making.
    fireEvent.click(screen.getByText("Back to edit"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Transaction status unknown/i)).toBeNull();
    expect(flow.intent.receiveAmount).toBe("5");
    expect(flow.intent.receiveToken).toBe("USDC");
  });
});
