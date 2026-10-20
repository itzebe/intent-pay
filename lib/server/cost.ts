import { getStore } from "@/lib/store";
import type { CostRecord } from "@/lib/store/types";

/**
 * AI / provider cost accounting.
 *
 * Intent Pay's only paid AI dependency is the optional intent LLM (OpenAI or a
 * compatible endpoint); everything else (RPC, prices, paymaster) is either free
 * at this scale or not billed per request in a way this app can see. So this
 * module records what it can actually measure — request counts, model, and
 * token usage when the provider returns it — and *estimates* cost from a
 * configurable price table.
 *
 * It never calls a calculated estimate an invoice, and it never records prompts
 * or payment instructions. Only counts and token totals are stored.
 *
 * Costs are rolled up per (UTC day, provider, kind). Budget thresholds are
 * configured server-side (`INTENT_PAY_AI_MONTHLY_BUDGET_USD`) and can be
 * overridden through the admin endpoint.
 */

export type LlmPricing = { inputPer1k: number; outputPer1k: number };

/**
 * Configurable per-model prices (USD per 1,000 tokens). Defaults reflect a
 * small, cheap model; operators override with `INTENT_PAY_LLM_PRICING` (JSON)
 * so an estimate always tracks the real contract. These are ESTIMATES.
 */
const DEFAULT_PRICING: Record<string, LlmPricing> = {
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  default: { inputPer1k: 0.0005, outputPer1k: 0.0015 },
};

export function pricingFor(model: string): LlmPricing {
  const override = process.env.INTENT_PAY_LLM_PRICING;
  if (override) {
    try {
      const parsed = JSON.parse(override) as Record<string, LlmPricing>;
      if (parsed[model]) return parsed[model];
      if (parsed.default) return parsed.default;
    } catch {
      /* malformed override: fall through to defaults */
    }
  }
  return DEFAULT_PRICING[model] ?? DEFAULT_PRICING.default;
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = pricingFor(model);
  return (inputTokens / 1000) * p.inputPer1k + (outputTokens / 1000) * p.outputPer1k;
}

/** The UTC day key, "YYYY-MM-DD". */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export type RecordUsageInput = {
  provider: string;
  kind: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  errors?: number;
  retries?: number;
  /** An already-computed estimated cost, when the caller knows it. */
  estimatedCostUsd?: number;
  at?: number;
};

/** Accumulate one usage event into the daily rollup (atomic upsert). */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  const store = getStore();
  const day = utcDay(input.at ?? Date.now());
  const cost =
    input.estimatedCostUsd ??
    estimateCostUsd(input.model ?? "default", input.inputTokens ?? 0, input.outputTokens ?? 0);
  const existing = await store.findOne("costs", { day, provider: input.provider, kind: input.kind });
  if (existing) {
    await store.update(
      "costs",
      { day, provider: input.provider, kind: input.kind },
      {
        requests: existing.requests + 1,
        inputTokens: existing.inputTokens + (input.inputTokens ?? 0),
        outputTokens: existing.outputTokens + (input.outputTokens ?? 0),
        estimatedCostUsd: String(Number(existing.estimatedCostUsd) + cost),
        errors: existing.errors + (input.errors ?? 0),
        retries: existing.retries + (input.retries ?? 0),
      },
    );
  } else {
    await store.insert("costs", {
      day,
      provider: input.provider,
      kind: input.kind,
      requests: 1,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      estimatedCostUsd: String(cost),
      errors: input.errors ?? 0,
      retries: input.retries ?? 0,
    });
  }
}

export type CostTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  errors: number;
  retries: number;
};

function emptyTotals(): CostTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, errors: 0, retries: 0 };
}

export async function costsInRange(fromDay: string, toDay: string): Promise<CostRecord[]> {
  // Lexicographic comparison is valid for ISO "YYYY-MM-DD" day keys.
  const rows = await getStore().findMany("costs", undefined, { orderBy: "day", dir: "asc" });
  return rows.filter((r) => r.day >= fromDay && r.day <= toDay);
}

export function totalsFor(records: CostRecord[]): CostTotals {
  const t = emptyTotals();
  for (const r of records) {
    t.requests += r.requests;
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.estimatedCostUsd += Number(r.estimatedCostUsd);
    t.errors += r.errors;
    t.retries += r.retries;
  }
  return t;
}

/** The month-to-date totals, plus today's. */
export async function costSummary(now = Date.now()): Promise<{
  today: CostTotals;
  monthToDate: CostTotals;
  byProvider: Record<string, CostTotals>;
}> {
  const day = utcDay(now);
  const monthStart = `${day.slice(0, 7)}-01`;
  const month = await costsInRange(monthStart, day);
  const byProvider: Record<string, CostTotals> = {};
  for (const r of month) {
    const t = byProvider[r.provider] ?? emptyTotals();
    t.requests += r.requests;
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.estimatedCostUsd += Number(r.estimatedCostUsd);
    t.errors += r.errors;
    t.retries += r.retries;
    byProvider[r.provider] = t;
  }
  return {
    today: totalsFor(await costsInRange(day, day)),
    monthToDate: totalsFor(month),
    byProvider,
  };
}

// ---- Budgets & thresholds --------------------------------------------------

const BUDGET_KEY = "ai_monthly_budget_usd";
const ALERT_STATE_KEY = "ai_budget_alert_state";

export type BudgetThresholds = { warn: number; high: number; critical: number };
export const DEFAULT_THRESHOLDS: BudgetThresholds = { warn: 0.7, high: 0.85, critical: 0.95 };

/** The configured monthly budget (USD), or null when unset. */
export async function monthlyBudgetUsd(): Promise<number | null> {
  const stored = await getStore().findOne("kv", { key: BUDGET_KEY });
  if (stored) {
    const n = Number(stored.value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const env = process.env.INTENT_PAY_AI_MONTHLY_BUDGET_USD;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Set the monthly budget (admin only). A value <= 0 clears it. */
export async function setMonthlyBudgetUsd(value: number, now = Date.now()): Promise<void> {
  if (!Number.isFinite(value) || value <= 0) {
    await getStore().remove("kv", { key: BUDGET_KEY });
    return;
  }
  await getStore().upsert("kv", { key: BUDGET_KEY, value: String(value), updatedAt: now });
}

export type BudgetState = {
  budgetUsd: number | null;
  spentUsd: number;
  fraction: number | null;
  threshold: "none" | "warn" | "high" | "critical" | "over";
  estimated: true;
};

export async function budgetState(now = Date.now()): Promise<BudgetState> {
  const budget = await monthlyBudgetUsd();
  const spent = (await costSummary(now)).monthToDate.estimatedCostUsd;
  if (budget === null) {
    return { budgetUsd: null, spentUsd: spent, fraction: null, threshold: "none", estimated: true };
  }
  const fraction = spent / budget;
  const t = DEFAULT_THRESHOLDS;
  const threshold: BudgetState["threshold"] =
    fraction >= 1 ? "over" : fraction >= t.critical ? "critical" : fraction >= t.high ? "high" : fraction >= t.warn ? "warn" : "none";
  return { budgetUsd: budget, spentUsd: spent, fraction, threshold, estimated: true };
}

export type BudgetAlert = { level: "warn" | "high" | "critical"; fraction: number; budgetUsd: number; spentUsd: number };

/**
 * Compute a budget alert, deduplicated by level so a threshold is announced at
 * most once per day. Returns null when nothing new crossed a threshold.
 */
export async function checkBudgetAlert(now = Date.now()): Promise<BudgetAlert | null> {
  const state = await budgetState(now);
  if (state.threshold === "none" || state.threshold === "over" || state.budgetUsd === null) return null;
  const level = state.threshold as BudgetAlert["level"];
  const day = utcDay(now);
  const store = getStore();
  const stored = await store.findOne("kv", { key: ALERT_STATE_KEY });
  let seen: Record<string, string> = {};
  try {
    seen = stored ? JSON.parse(stored.value) : {};
  } catch {
    seen = {};
  }
  if (seen[level] === day) return null;
  seen[level] = day;
  await store.upsert("kv", { key: ALERT_STATE_KEY, value: JSON.stringify(seen), updatedAt: now });
  return { level, fraction: state.fraction ?? 0, budgetUsd: state.budgetUsd, spentUsd: state.spentUsd };
}

// ---- Traffic forecasting ---------------------------------------------------

export type ForecastPoint = { multiplier: number; monthlyRequests: number; monthlyCostUsd: number };

export type ForecastInput = {
  /** Measured month-to-date requests, or an assumed baseline when unmeasured. */
  monthlyRequests: number;
  /** Estimated cost per request (USD). */
  costPerRequest: number;
  /** Whether the request figure is measured or assumed. */
  measured: boolean;
  multipliers?: number[];
};

export function forecast(input: ForecastInput): ForecastPoint[] {
  const multipliers = input.multipliers ?? [1, 2, 5, 10];
  return multipliers.map((m) => ({
    multiplier: m,
    monthlyRequests: Math.round(input.monthlyRequests * m),
    monthlyCostUsd: input.monthlyRequests * m * input.costPerRequest,
  }));
}

/**
 * A transparent, scenario-based estimator. When there is no measured traffic it
 * uses explicit, configurable assumptions and labels the result "assumed" — it
 * never presents an assumption as a measurement.
 */
export async function buildForecast(now = Date.now()): Promise<{
  measured: boolean;
  monthlyRequests: number;
  costPerRequest: number;
  points: ForecastPoint[];
  note: string;
}> {
  const summary = await costSummary(now);
  const day = utcDay(now);
  const dayOfMonth = Number(day.slice(8, 10));
  const measuredRequests = summary.monthToDate.requests;
  const measuredCost = summary.monthToDate.estimatedCostUsd;
  const measured = measuredRequests > 0;
  const monthlyRequests = measured
    ? Math.round((measuredRequests / Math.max(1, dayOfMonth)) * 30)
    : Number(process.env.INTENT_PAY_ASSUMED_MONTHLY_REQUESTS ?? 1000);
  const costPerRequest = measured && measuredRequests > 0 ? measuredCost / measuredRequests : estimateCostUsd("default", 700, 120);
  return {
    measured,
    monthlyRequests,
    costPerRequest,
    points: forecast({ monthlyRequests, costPerRequest, measured }),
    note: measured
      ? "Projected from measured month-to-date usage."
      : "No measured usage yet — a scenario estimate from configurable assumptions.",
  };
}
