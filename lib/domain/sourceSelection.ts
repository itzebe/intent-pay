import type { Balance } from "@/lib/domain/intent";
import { parseUnits } from "@/lib/domain/math";

/**
 * Deterministic source-asset selection.
 *
 * The asset the user names in the intent is the RECIPIENT asset — not
 * automatically what they pay with. This module decides which asset the sender
 * actually spends, from real live data, and explains the choice.
 *
 * It is pure and total (no React, no network), so the ranking rules are
 * unit-testable. The caller supplies already-fetched live inputs:
 *   - the wallet's balances (chain-confirmed),
 *   - the gas-aware optimizer's per-asset quotes (real routes/prices),
 *   - the resolved gas mode.
 *
 * Rules (in order):
 *   1. An EXPLICIT source (the user chose it, or the instruction fixed both
 *      sides) is never replaced while it is still executable + sufficient.
 *      If it stops being usable we keep it selected and report why — the user
 *      decides, we never silently swap their choice.
 *   2. Otherwise pick the best EXECUTABLE, SUFFICIENT asset: the optimizer's
 *      ranking, which is total live cost (spend + network), using real routes.
 *   3. Never select an asset whose balance is insufficient.
 *   4. Never select an asset with no executable route.
 *   5. Never select an asset whose required gas cannot actually be paid, unless
 *      a configured paymaster/ERC-20-gas path genuinely covers it.
 *   6. Never select an asset merely because of a hardcoded priority; the
 *      recipient asset is preferred only when it is genuinely the best option.
 */

export type GasMode = "sponsored" | "erc20" | "native";

/** One candidate source, as priced by the optimizer. */
export type SourceOption = {
  symbol: string;
  address?: string;
  ok: boolean;
  sufficient: boolean;
  payAmount?: string;
  payUsd?: number;
  routePath?: string[];
  totalSenderCostUsd?: number;
  reason?: string;
};

export type SourceSelectionInput = {
  /** The recipient asset (what they get) — never rewritten by this function. */
  recipientAsset: string;
  /** The wallet's live balances. */
  balances: Balance[];
  /** Ranked live options from the optimizer (best first). */
  options?: SourceOption[];
  /** The user's explicit source, when they chose one or the intent fixed it. */
  explicit?: { symbol: string; origin: "user" | "intent" } | null;
  /** How gas is expected to be paid for the current payment. */
  gasMode: GasMode;
  /** MON required for the network fee (base units as a decimal string, if known). */
  gasRequiredMon?: string;
  /** Whether a configured paymaster/wallet path actually covers gas. */
  gasAbstracted: boolean;
  /** True while the optimizer is still producing options (avoid false blockers). */
  pending?: boolean;
};

export type SourceSelection = {
  /** The chosen source asset symbol, or null when nothing is executable. */
  sourceAsset: string | null;
  sourceAddress?: string;
  /** Deterministic, human-readable reason for the choice. */
  reason: string;
  /** A stable machine code for the reason. */
  code: SourceReasonCode;
  /**
   * True when the engine cannot decide yet (no priced options while it is still
   * loading). Callers must not surface this as a hard failure.
   */
  pending: boolean;
  /** The chosen option's live economics, when known. */
  requiredAmount?: string;
  routePath?: string[];
  remainingBalance?: string;
  /** The concrete blocker when no source is executable. */
  blocker?: string;
};

export type SourceReasonCode =
  | "explicit_user"
  | "explicit_intent"
  | "explicit_unusable"
  | "auto_best_cost"
  | "direct_recipient_asset"
  | "none_executable"
  | "no_balances";

/** Find a candidate option by symbol. */
function optionFor(options: SourceOption[], symbol: string): SourceOption | undefined {
  const needle = symbol.toLowerCase();
  return options.find((o) => o.symbol.toLowerCase() === needle);
}

function balanceFor(balances: Balance[], symbol: string): Balance | undefined {
  const needle = symbol.toLowerCase();
  return balances.find((b) => b.token.symbol.toLowerCase() === needle);
}

/** Remaining balance after the payment, as a decimal string (or undefined). */
function remainingAfter(bal: Balance | undefined, required: string | undefined): string | undefined {
  if (!bal || !required) return undefined;
  try {
    const have = parseUnits(bal.amount, bal.token.decimals);
    const need = parseUnits(required, bal.token.decimals);
    if (need > have) return undefined;
    const left = have - need;
    return (Number(left) / 10 ** bal.token.decimals).toString();
  } catch {
    return undefined;
  }
}

/**
 * Whether the network fee can actually be paid. A sponsored/ERC-20-gas payment
 * is always covered. A native-gas payment needs enough MON; when the source is
 * native MON itself the fee is drawn from the same balance, which the optimizer
 * already reserves for, so the balance check is what matters.
 */
export function gasCovered(input: SourceSelectionInput): boolean {
  if (input.gasAbstracted) return true;
  const native = input.balances.find((b) => b.token.native);
  if (!native) return false;
  if (!input.gasRequiredMon) return true; // unknown fee does not block
  try {
    const have = parseUnits(native.amount, 18);
    const need = parseUnits(input.gasRequiredMon, 18);
    return have >= need;
  } catch {
    return true;
  }
}

export function selectSource(input: SourceSelectionInput): SourceSelection {
  const options = input.options ?? [];
  const { balances, explicit, gasMode } = input;

  if (balances.length === 0) {
    return {
      sourceAsset: null,
      code: "no_balances",
      reason: "No supported balances found in this wallet.",
      blocker: "Connect a wallet that holds a supported asset.",
      pending: false,
    };
  }

  // No priced options yet (the optimizer is still producing them): we cannot
  // decide, but this is not a failure — don't emit a false "nothing is enough".
  // Only treat an empty option set as "pending" while the optimizer is loading;
  // a settled empty set falls through to an explicit blocker below.
  if (options.length === 0 && input.pending) {
    return {
      sourceAsset: null,
      code: explicit ? "explicit_intent" : "auto_best_cost",
      reason: "Finding the best asset to pay with…",
      pending: true,
    };
  }

  // 1. An explicit choice is authoritative while it remains usable.
  if (explicit) {
    const opt = optionFor(options, explicit.symbol);
    const bal = balanceFor(balances, explicit.symbol);
    const usable =
      Boolean(opt && opt.ok && opt.sufficient) && gasCovered(input) && Boolean(bal);
    const code: SourceReasonCode = explicit.origin === "user" ? "explicit_user" : "explicit_intent";
    if (usable) {
      return {
        sourceAsset: explicit.symbol,
        sourceAddress: opt?.address ?? bal?.token.address,
        code,
        reason:
          explicit.origin === "user"
            ? `You chose to pay with ${explicit.symbol}.`
            : `Your instruction fixed ${explicit.symbol} as the source.`,
        requiredAmount: opt?.payAmount,
        routePath: opt?.routePath,
        remainingBalance: remainingAfter(bal, opt?.payAmount),
        pending: false,
      };
    }
    // Keep the explicit choice selected, but report — never silently replace it.
    return {
      sourceAsset: explicit.symbol,
      sourceAddress: bal?.token.address,
      code: "explicit_unusable",
      reason: `${explicit.symbol} can't currently pay this: ${describeUnusable(opt, bal)}. Pick another asset.`,
      blocker: describeUnusable(opt, bal),
      routePath: opt?.routePath,
      pending: false,
    };
  }

  // 2. Auto-select: the best executable + sufficient option (live cost order).
  const eligible = options.filter((o) => o.ok && o.sufficient);
  const gasOk = gasCovered(input) ? eligible : [];
  const best = gasOk[0];
  if (best) {
    const bal = balanceFor(balances, best.symbol);
    const direct = best.symbol.toLowerCase() === input.recipientAsset.toLowerCase();
    return {
      sourceAsset: best.symbol,
      sourceAddress: best.address ?? bal?.token.address,
      code: direct ? "direct_recipient_asset" : "auto_best_cost",
      reason: direct
        ? `You already hold ${best.symbol}, so no conversion is needed.`
        : `Best executable source: ${best.symbol}${best.routePath ? ` (${best.routePath.join(" → ")})` : ""}.`,
      requiredAmount: best.payAmount,
      routePath: best.routePath,
      remainingBalance: remainingAfter(bal, best.payAmount),
      pending: false,
    };
  }

  // 3. Nothing executable — say exactly why rather than guessing an asset.
  const anyRoutable = options.find((o) => o.ok);
  const anyFunded = options.find((o) => o.sufficient);
  const blocker = !anyFunded
    ? "None of your holdings is enough for this payment."
    : !anyRoutable
      ? `No executable route from any funded asset to ${input.recipientAsset}.`
      : !input.gasAbstracted && gasMode === "native"
        ? "You don't hold enough MON for the network fee."
        : "No executable source asset was found.";
  return {
    sourceAsset: null,
    code: "none_executable",
    reason: blocker,
    blocker,
    pending: false,
  };
}

function describeUnusable(opt: SourceOption | undefined, bal: Balance | undefined): string {
  if (!bal) return "you don't hold it";
  if (!opt) return "it couldn't be priced";
  if (!opt.ok) return opt.reason ?? "no executable route";
  if (!opt.sufficient) return "your balance is too low";
  return "the network fee can't be covered";
}
