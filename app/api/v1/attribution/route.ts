import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { getStore } from "@/lib/store";
import { NextResponse } from "next/server";
import { setPaymentXpub } from "@/lib/developer/attribution";
import { validatePaymentXpub } from "@/lib/developer/xpub";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/attribution — the merchant's checkout-attribution configuration.
 *
 * Reports whether checkout-bound attribution is enabled (a payment xpub is
 * registered) and, if so, a short preview of the next destinations. The xpub
 * itself is **never** returned: it reveals every derived address, so it is a
 * server-side secret. Only the derived addresses the merchant will already see in
 * their own wallet are previewed.
 */
export async function GET(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const developer = await getStore().findOne("apiDevelopers", { id: auth.auth.developer.id });
  const enabled = Boolean(developer?.paymentXpub);
  return apiOk({
    attribution: {
      /** "checkout_bound" once an xpub is registered, else "shared_recipient". */
      mode: enabled ? "checkout_bound" : "shared_recipient",
      checkoutBound: enabled,
      nextDerivationIndex: developer?.nextDerivationIndex ?? 0,
      /** A preview of the next few destinations (never the xpub). */
      preview: await previewAddresses(developer?.paymentXpub ?? null, developer?.nextDerivationIndex ?? 0, enabled ? 3 : 0),
      note: enabled
        ? "Each checkout is paid to a unique address derived from your xpub. Sweep funds with the wallet that holds the matching seed."
        : "Register a payment xpub (POST a `paymentXpub`) to give each checkout a unique destination. Without it, checkouts share your recipient and attribution is weaker.",
    },
  });
}

/**
 * POST /api/v1/attribution — register (or clear) the payment xpub.
 *
 * Body: `{ paymentXpub: "xpub…" }` to enable, or `{ paymentXpub: null }` to
 * disable. Only a **public** extended key is accepted: a private key (`xprv`) or a
 * seed phrase is refused, so Intent Pay can never be handed a spending key.
 */
export async function POST(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const limited = await checkLimit(auth.auth.developer.id, "write");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const body = await readJson(req);
  if (!body || !("paymentXpub" in body)) {
    return apiError("invalid_request", "Provide `paymentXpub` (a public extended key) or null to disable.", auth.requestId, "paymentXpub");
  }
  const raw = body.paymentXpub;
  if (raw !== null && typeof raw !== "string") {
    return apiError("invalid_request", "`paymentXpub` must be a string or null.", auth.requestId, "paymentXpub");
  }

  const result = await setPaymentXpub(auth.auth.developer.id, raw as string | null);
  if (!result.ok) return apiError("invalid_request", result.reason, auth.requestId, "paymentXpub");

  const developer = await getStore().findOne("apiDevelopers", { id: auth.auth.developer.id });
  const enabled = Boolean(developer?.paymentXpub);
  return apiOk({
    attribution: {
      mode: enabled ? "checkout_bound" : "shared_recipient",
      checkoutBound: enabled,
      nextDerivationIndex: developer?.nextDerivationIndex ?? 0,
      preview: await previewAddresses(developer?.paymentXpub ?? null, developer?.nextDerivationIndex ?? 0, enabled ? 3 : 0),
    },
  });
}

/** Derive a small preview of upcoming destinations, or [] when disabled. */
async function previewAddresses(xpub: string | null, from: number, count: number): Promise<string[]> {
  if (!xpub || count <= 0) return [];
  if (!validatePaymentXpub(xpub).ok) return [];
  const { derivePaymentAddresses } = await import("@/lib/developer/xpub");
  try {
    return derivePaymentAddresses(xpub, from, count);
  } catch {
    return [];
  }
}
