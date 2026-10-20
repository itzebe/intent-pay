import { NextResponse } from "next/server";
import { adminAuthorized, adminConfigured } from "@/lib/server/auth";
import { budgetState, buildForecast, costSummary, monthlyBudgetUsd, setMonthlyBudgetUsd } from "@/lib/server/cost";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/cost — AI/provider cost accounting and a transparent forecast.
 *
 * Admin-only. Every monetary figure is labelled an ESTIMATE: it is derived from a
 * configurable price table, not an invoice. When no usage has been measured the
 * forecast is labelled an assumption, never presented as measured traffic.
 */
export async function GET(req: Request) {
  if (!adminConfigured()) {
    return NextResponse.json({ ok: false, code: "not_configured", message: "Cost accounting is not configured." }, { status: 503 });
  }
  if (!adminAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Not authorized." }, { status: 401 });
  }

  const summary = await costSummary();
  const budget = await budgetState();
  const forecast = await buildForecast();

  return NextResponse.json({
    ok: true,
    estimated: true,
    note: "Costs are estimates from a configurable price table, not an invoice.",
    today: summary.today,
    monthToDate: summary.monthToDate,
    byProvider: summary.byProvider,
    budget: {
      budgetUsd: budget.budgetUsd,
      spentUsd: budget.spentUsd,
      fraction: budget.fraction,
      threshold: budget.threshold,
    },
    forecast,
  });
}

/**
 * POST /api/ops/cost — set the monthly AI budget (admin only).
 *
 * Body: { budgetUsd: number }. A non-positive value clears the budget. This is
 * server configuration, not user data, and is recorded in the kv table.
 */
export async function POST(req: Request) {
  if (!adminConfigured()) {
    return NextResponse.json({ ok: false, code: "not_configured", message: "Cost accounting is not configured." }, { status: 503 });
  }
  if (!adminAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Not authorized." }, { status: 401 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const value = Number(body?.budgetUsd);
  if (!Number.isFinite(value)) {
    return NextResponse.json({ ok: false, message: "A numeric budgetUsd is required." }, { status: 400 });
  }
  await setMonthlyBudgetUsd(value);
  return NextResponse.json({ ok: true, budgetUsd: await monthlyBudgetUsd() });
}
