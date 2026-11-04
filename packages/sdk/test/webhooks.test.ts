import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeWebhookSignature,
  parseSignatureHeader,
  verifyWebhookSignature,
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
} from "../src/webhooks.js";

const SECRET = "whsec_0123456789abcdef0123456789abcdef0123456789abcdef";

/** The server's signing rule, reproduced with node:crypto, to cross-check. */
function serverSignature(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

describe("parseSignatureHeader", () => {
  it("parses t and v1", () => {
    expect(parseSignatureHeader("t=1700000000,v1=abc")).toEqual({ t: 1700000000, v1: "abc" });
  });

  it("returns nothing for a malformed header", () => {
    expect(parseSignatureHeader("")).toEqual({});
    expect(parseSignatureHeader("garbage")).toEqual({});
  });
});

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ id: "e1", type: "payment.verified", data: { intentId: "int_1" } });
  const now = 1_700_000_000;

  it("accepts a signature produced by the server's exact rule", async () => {
    const header = serverSignature(SECRET, body, now);
    const result = await verifyWebhookSignature({ secret: SECRET, signature: header, body, nowSeconds: now });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a signature computed by the SDK's own helper", async () => {
    const v1 = await computeWebhookSignature(SECRET, body, now);
    const result = await verifyWebhookSignature({ secret: SECRET, signature: `t=${now},v1=${v1}`, body, nowSeconds: now });
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong secret", async () => {
    const header = serverSignature(SECRET, body, now);
    const result = await verifyWebhookSignature({ secret: "whsec_wrong", signature: header, body, nowSeconds: now });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a tampered body", async () => {
    const header = serverSignature(SECRET, body, now);
    const result = await verifyWebhookSignature({ secret: SECRET, signature: header, body: body + " ", nowSeconds: now });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a replay outside the timestamp tolerance", async () => {
    const header = serverSignature(SECRET, body, now);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      signature: header,
      body,
      nowSeconds: now + DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 1,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("accepts a delivery inside the tolerance window", async () => {
    const header = serverSignature(SECRET, body, now);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      signature: header,
      body,
      nowSeconds: now + DEFAULT_SIGNATURE_TOLERANCE_SECONDS - 1,
    });
    expect(result.ok).toBe(true);
  });

  it("honors a custom tolerance", async () => {
    const header = serverSignature(SECRET, body, now);
    const result = await verifyWebhookSignature({ secret: SECRET, signature: header, body, nowSeconds: now + 10, toleranceSeconds: 5 });
    expect(result).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("reports a missing signature", async () => {
    expect(await verifyWebhookSignature({ secret: SECRET, signature: "", body })).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("reports a malformed signature", async () => {
    expect(await verifyWebhookSignature({ secret: SECRET, signature: "v1=only", body })).toEqual({ ok: false, reason: "malformed_signature" });
  });
});
