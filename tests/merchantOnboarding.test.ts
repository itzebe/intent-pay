import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ROUTES } from "@/lib/config/site";
import { WEBHOOK_EVENTS } from "@/lib/developer/intentLifecycle";
import { RETRY_SCHEDULE_SECONDS, MAX_ATTEMPTS } from "@/lib/developer/webhooks";
import { API_ERROR_CODES } from "@/lib/developer/errors";

/**
 * Merchant-onboarding truthfulness.
 *
 * The merchant surface makes commercial claims about a real system. These tests
 * pin those claims to the implementation so the page, the guide and the API
 * cannot drift apart — and so a capability is never advertised before it exists.
 *
 * They also assert the limits are stated honestly: no sandbox, no refunds, and
 * operator-gated production signup.
 */

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("merchant landing page answers the five questions", () => {
  const page = read("app/merchants/page.tsx");

  it("exists, is a real public route and is not a redirect stub", () => {
    expect(existsSync(join(root, "app/merchants/page.tsx"))).toBe(true);
    expect(PUBLIC_ROUTES.map((r) => r.path)).toContain("/merchants");
    expect(page.length).toBeGreaterThan(2000);
  });

  it("covers what it does, how a customer pays, how you know, how to integrate, how to start", () => {
    // Each of the five questions has a real section on the page.
    for (const heading of [
      "How a customer pays",
      "How you know payment succeeded",
      "How to integrate",
      "Get started in five steps",
    ]) {
      expect(page, `merchants page omits "${heading}"`).toContain(heading);
    }
  });

  it("states the real lifecycle, ending in verified settlement (not a broadcast)", () => {
    for (const step of [
      "You create the order",
      "The customer opens the link",
      "The customer authorizes",
      "Intent Pay verifies settlement",
      "You read the verified outcome",
    ]) {
      expect(page, `lifecycle omits "${step}"`).toContain(step);
    }
    // A broadcast alone is never paid.
    expect(page).toMatch(/never treated as paid|never as paid/);
  });

  it("names only real integration endpoints", () => {
    expect(page).toContain("/api/v1/intents");
    expect(page).toContain("/api/v1/checkouts");
    // No invented provider-style endpoints.
    expect(page).not.toMatch(/\/api\/v1\/(refunds|payouts|subscriptions|charges)\b/);
  });
});

describe("merchant page states the real limits honestly", () => {
  const page = read("app/merchants/page.tsx");

  it("does not claim a sandbox or testnet", () => {
    expect(page).toMatch(/no sandbox|There is no sandbox/i);
    expect(page).toMatch(/mainnet only/i);
    // It must not promise a fake risk-free mode.
    expect(page).not.toMatch(/test mode is risk-free|sandbox mode/i);
  });

  it("does not claim refunds or a service fee", () => {
    expect(page).toMatch(/Refunds are not implemented/i);
    expect(page).not.toMatch(/refund (an|a) (payment|order) via|refund endpoint/i);
  });

  it("states self-service signup and does not claim an operator is required", () => {
    expect(page).toMatch(/self-service/i);
    expect(page).toMatch(/verification link/i);
    expect(page).not.toMatch(/sign up for free|create an account in one click/i);
  });

  it("makes no fabricated social proof", () => {
    expect(page).not.toMatch(/\b\d+[,.]?\d*\s*(merchants|businesses|customers)\b/i);
    expect(page).not.toMatch(/testimonial|trusted by|backed by/i);
  });
});

describe("merchant guide matches the implementation", () => {
  const guide = read("docs/merchants.md");

  it("documents all sixteen required sections", () => {
    for (const n of [
      "## 1. Overview",
      "## 2. Supported merchant use cases",
      "## 3. Current capability limitations",
      "## 4. Prerequisites",
      "## 5. Authentication",
      "## 6. Credential acquisition",
      "## 7. Payment creation",
      "## 8. Checkout integration",
      "## 9. Payment status retrieval",
      "## 10. Settlement verification",
      "## 11. Idempotency",
      "## 12. Webhooks",
      "## 13. Error handling",
      "## 14. Security responsibilities",
      "## 15. Testing",
      "## 16. Production onboarding",
    ]) {
      expect(guide, `merchant guide omits "${n}"`).toContain(n);
    }
  });

  it("uses the real webhook signature scheme, not an invented one", () => {
    expect(guide).toContain("X-IntentPay-Signature");
    expect(guide).toContain("t=<unix-seconds>,v1=<hex HMAC-SHA256>");
    expect(guide).toContain("verifyWebhookSignature");
    // The documented retry schedule must equal the implementation's.
    expect(guide).toContain(RETRY_SCHEDULE_SECONDS.join(", "));
  });

  it("lists the real webhook events", () => {
    for (const ev of ["checkout.created", "payment.verified", "transaction.submitted"]) {
      expect(WEBHOOK_EVENTS as readonly string[]).toContain(ev);
      expect(guide, `guide omits event ${ev}`).toContain(ev);
    }
  });

  it("documents only real error codes", () => {
    for (const code of ["invalid_request", "unauthorized", "forbidden", "replay_detected", "storage_unavailable"]) {
      expect(API_ERROR_CODES as readonly string[]).toContain(code);
      expect(guide, `guide omits error code ${code}`).toContain(code);
    }
    // A refund error code is not part of the API and must not be documented.
    expect(guide).not.toMatch(/refund_/);
  });

  it("does not invent a refund endpoint or a webhook signature format", () => {
    expect(guide).not.toMatch(/POST \/api\/v1\/refunds/);
    expect(guide).not.toMatch(/X-Signature:/);
  });

  it("states self-service signup, distinguishing it from operator provisioning", () => {
    expect(guide).toMatch(/self-service/i);
    expect(guide).toContain("/api/v1/developers/register");
    expect(guide).toContain("/api/v1/developers/verify");
    expect(guide).toContain("INTENT_PAY_ADMIN_TOKEN");
    expect(guide).toMatch(/Operator provisioning/i);
  });
});

describe("merchant capability claims map to real code", () => {
  it("the advertised webhook behaviour exists in the implementation", () => {
    expect(MAX_ATTEMPTS).toBe(RETRY_SCHEDULE_SECONDS.length + 1);
    const webhooks = read("lib/developer/webhooks.ts");
    expect(webhooks).toContain("X-IntentPay-Signature");
    expect(webhooks).toContain("verifySignature");
    expect(webhooks).toContain("SIGNATURE_TOLERANCE_SECONDS");
  });

  it("the advertised checkout routes exist on disk", () => {
    for (const p of [
      "app/api/v1/intents/route.ts",
      "app/api/v1/checkouts/route.ts",
      "app/api/v1/checkouts/[id]/verify/route.ts",
      "app/api/v1/checkouts/[id]/evidence/route.ts",
      "app/api/v1/attribution/route.ts",
      "app/api/v1/webhooks/route.ts",
      "app/api/checkout/[token]/route.ts",
      "app/api/checkout/[token]/submit/route.ts",
      "app/api/checkout/[token]/verify/route.ts",
    ]) {
      expect(existsSync(join(root, p)), `${p} missing`).toBe(true);
    }
  });

  it("does not advertise a sandbox or testnet that does not exist", () => {
    const capabilities = read("app/api/v1/capabilities/route.ts");
    expect(capabilities).toMatch(/Only Monad Mainnet is supported|no testnet/i);
  });

  it("keeps operator provisioning behind the admin gate", () => {
    const route = read("app/api/v1/developers/route.ts");
    expect(route).toContain("adminAuthorized");
    expect(route).toMatch(/requires the admin token/);
  });
});

describe("SDK publication readiness", () => {
  it("ships a LICENSE file and includes it in the published package", () => {
    expect(existsSync(join(root, "packages/sdk/LICENSE"))).toBe(true);
    expect(existsSync(join(root, "LICENSE"))).toBe(true);
    const pkg = JSON.parse(read("packages/sdk/package.json"));
    expect(pkg.license).toBe("MIT");
    expect(pkg.files).toContain("LICENSE");
  });

  it("declares the entries, types and repository a published package needs", () => {
    const pkg = JSON.parse(read("packages/sdk/package.json"));
    expect(pkg.name).toBe("@intentpay/sdk");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.exports["."].types).toBeTruthy();
    expect(pkg.exports["."].import).toBeTruthy();
    expect(pkg.exports["."].require).toBeTruthy();
    expect(pkg.repository.directory).toBe("packages/sdk");
  });
});

describe("merchant demonstration is safe and honest", () => {
  const demo = read("examples/merchant-onboarding/demo.mjs");

  it("imports only the published SDK, never application internals", () => {
    const imports = [...demo.matchAll(/^\s*import\s+[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(
        specifier.startsWith("node:") || specifier.includes("packages/sdk/dist"),
        `unexpected import in the demo: ${specifier}`,
      ).toBe(true);
    }
    expect(demo).not.toMatch(/from\s+["']@\//);
    expect(demo).not.toMatch(/from\s+["'][^"']*\blib\//);
  });

  it("never signs or broadcasts, and only reports a payment when verified", () => {
    expect(demo).toMatch(/verdict === "verified"/);
    expect(demo).toMatch(/Do not treat this as paid/);
    expect(demo).toMatch(/process\.exitCode/);
    // It must not contain signing/broadcast primitives.
    expect(demo).not.toMatch(/eth_sendTransaction|sendTransaction|personal_sign|eth_sign/);
  });

  it("drives the documented merchant lifecycle", () => {
    for (const call of [
      "getCapabilities",
      "getAccount",
      "createIntent",
      "validateIntent",
      "createCheckout",
      "prepareCheckout",
    ]) {
      expect(demo, `demo omits ${call}`).toContain(call);
    }
  });
});
