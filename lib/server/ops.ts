import { randomUUID } from "node:crypto";
import { getStore } from "@/lib/store";
import type { OpsEventRecord } from "@/lib/store/types";
import { classificationOf, type FailureCategory, type FailureSeverity } from "@/lib/domain/failureTaxonomy";
import { redactDiagnostic } from "@/lib/server/paymentAttempts";

/**
 * Operational error collection.
 *
 * This is *forward-looking*: the application had no server-side error history
 * before this module, so historical incidents cannot be reconstructed. The ops
 * view says so explicitly rather than showing invented history. From the moment
 * this is deployed, every classified failure (and provider anomaly) is recorded
 * here, ordered by severity and time, and correlated to a payment attempt id
 * where one exists.
 *
 * Records carry no secrets, no raw prompts, no payment instructions and no
 * personal data — only a category, a service/route, a redacted message, and an
 * optional attempt id.
 */

const VALID_SEVERITIES: FailureSeverity[] = ["info", "warning", "error", "critical"];

export type RecordOpsInput = {
  category: FailureCategory | string;
  service: string;
  message?: string | null;
  severity?: FailureSeverity;
  attemptId?: string | null;
  unresolved?: boolean;
  at?: number;
};

export async function recordOpsEvent(input: RecordOpsInput): Promise<OpsEventRecord> {
  const known = (() => {
    try {
      return classificationOf(input.category as FailureCategory);
    } catch {
      return null;
    }
  })();
  const severity: FailureSeverity =
    input.severity ?? (known?.severity ?? "error");
  const record: OpsEventRecord = {
    id: randomUUID(),
    at: input.at ?? Date.now(),
    severity: VALID_SEVERITIES.includes(severity) ? severity : "error",
    category: input.category,
    service: input.service.slice(0, 120),
    message: redactDiagnostic(input.message),
    attemptId: input.attemptId ?? null,
    unresolved: input.unresolved ?? (severity === "error" || severity === "critical"),
  };
  try {
    await getStore().insert("opsEvents", record);
  } catch {
    // Telemetry must never break a payment path.
  }
  return record;
}

const SEVERITY_RANK: Record<string, number> = { critical: 3, error: 2, warning: 1, info: 0 };

export type OpsSummary = {
  windowHours: number;
  total: number;
  unresolved: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  byService: Record<string, number>;
  events: OpsEventRecord[];
};

/**
 * Recent errors ordered by severity then time. `sinceMs` defaults to the last
 * 24 hours. Frequency is reported per category and per service.
 */
export async function recentOps(sinceMs: number, now = Date.now(), limit = 200): Promise<OpsSummary> {
  const all = await getStore().findMany("opsEvents", undefined, { orderBy: "at", dir: "desc", limit: 5000 });
  const inWindow = all.filter((e) => e.at >= sinceMs);
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byService: Record<string, number> = {};
  for (const e of inWindow) {
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    byService[e.service] = (byService[e.service] ?? 0) + 1;
  }
  const sorted = [...inWindow].sort((a, b) => {
    const rank = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (rank !== 0) return rank;
    return b.at - a.at;
  });
  return {
    windowHours: Math.round((now - sinceMs) / 3_600_000),
    total: inWindow.length,
    unresolved: inWindow.filter((e) => e.unresolved).length,
    bySeverity,
    byCategory,
    byService,
    events: sorted.slice(0, limit),
  };
}
