// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * ReferralPanel: connecting a wallet must NOT request a signature.
 *
 * A wallet message signature is a real, user-visible prompt. It must only appear
 * when the user explicitly asks for referral access — never as a side effect of
 * connecting a wallet, and never confused with a transaction.
 */

const ensureSession = vi.fn(async () => true);
const hasSession = vi.fn(async () => false);

vi.mock("@/lib/referral/session", () => ({
  ensureSession: (...a: unknown[]) => ensureSession(...(a as [])),
  hasSession: (...a: unknown[]) => hasSession(...(a as [])),
  signOut: vi.fn(),
}));

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

let durableFlag = true;

const { ReferralPanel } = await import("@/components/referral/ReferralPanel");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  durableFlag = true;
  ensureSession.mockClear();
  hasSession.mockClear();
  hasSession.mockResolvedValue(false);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (String(url).includes("/api/referral/availability")) return json({ ok: true, durable: durableFlag });
      if (String(url).includes("/api/referral/me")) return json({ ok: false }, 401);
      return json({ ok: true });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("referral sign-in is user-initiated", () => {
  it("does not request a wallet signature just because a wallet is connected", async () => {
    render(<ReferralPanel address={SENDER} walletClient={{ account: { address: SENDER } } as never} />);
    // Let the availability + session-adoption effects settle.
    await waitFor(() => expect(hasSession).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("requests a signature only when the user asks to create a referral link", async () => {
    render(<ReferralPanel address={SENDER} walletClient={{ account: { address: SENDER } } as never} />);
    await waitFor(() => expect(screen.getByText(/Create my referral link/)).toBeTruthy());
    expect(ensureSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(/Create my referral link/));
    await waitFor(() => expect(ensureSession).toHaveBeenCalledTimes(1));
  });

  it("explains the limitation instead of offering sign-in when storage is not durable", async () => {
    durableFlag = false;
    render(<ReferralPanel address={SENDER} walletClient={{ account: { address: SENDER } } as never} />);
    await waitFor(() => expect(screen.getByText(/durable storage/i)).toBeTruthy());
    expect(screen.queryByText(/Create my referral link/)).toBeNull();
    expect(ensureSession).not.toHaveBeenCalled();
  });
});
