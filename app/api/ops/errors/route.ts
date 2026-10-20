import { NextResponse } from "next/server";
import { adminAuthorized, adminConfigured } from "@/lib/server/auth";
import { recentOps } from "@/lib/server/ops";
import { listAttempts } from "@/lib/server/paymentAttempts";
import { classificationOf, type FailureCategory } from "@/lib/domain/failureTaxonomy";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/errors — recent operational errors, ordered by severity then time.
 *
 * Admin-only (`INTENT_PAY_ADMIN_TOKEN`). When the token is unset the endpoint is
 * *unavailable* (503), never open — a missing secret must not mean "no auth".
 *
 * Historical note: the application recorded no server-side error history before
 * this feature shipped, so this view is forward-looking. It says so explicitly
 * rather than fabricating a backfilled history. Every event is classified with
 * the shared taxonomy and linked to a payment attempt id when one exists.
 */
export async function GET(req: Request) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { ok: false, code: "not_configured", message: "Operational diagnostics are not configured." },
      { status: 503 },
    );
  }
  if (!adminAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Not authorized." }, { status: 401 });
  }

  const url = new URL(req.url);
  const hours = clamp(Number(url.searchParams.get("hours") ?? 24), 1, 24 * 30);
  const summary = await recentOps(Date.now() - hours * 3_600_000);

  const attempts = await listAttempts(200);
  const unresolvedAttempts = attempts
    .filter((a) => a.status === "unknown" || a.status === "submitted" || a.status === "prepared" || a.status === "signing")
    .map((a) => ({
      id: a.id,
      status: a.status,
      failureCategory: a.failureCategory,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      intentKey: a.intentKey,
      gasMode: a.gasMode,
      txHash: a.txHash,
      userOpHash: a.userOpHash,
      mayHaveSubmitted: a.failureCategory
        ? classificationOf(a.failureCategory as FailureCategory).mayHaveSubmitted
        : a.status === "unknown",
    }));

  return NextResponse.json({
    ok: true,
    forwardLooking: true,
    note: "Error history begins when this feature is deployed; earlier incidents are not recorded.",
    window: { hours, since: Date.now() - hours * 3_600_000 },
    summary: {
      total: summary.total,
      unresolved: summary.unresolved,
      bySeverity: summary.bySeverity,
      byCategory: summary.byCategory,
      byService: summary.byService,
    },
    events: summary.events.map((e) => ({
      id: e.id,
      at: e.at,
      severity: e.severity,
      category: e.category,
      service: e.service,
      message: e.message,
      attemptId: e.attemptId,
      unresolved: e.unresolved,
    })),
    unresolvedAttempts,
  });
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
