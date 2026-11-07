// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DeveloperPortal } from "@/components/developer/DeveloperPortal";
import { VerifyClient } from "@/components/developer/VerifyClient";

/**
 * The self-service developer portal and the verification landing page.
 *
 * Drives the REAL components against a mocked `fetch`, so the flow logic is
 * exercised: registration posts the email, the one-time key is rendered with a
 * shown-once warning, and the verify page exchanges the URL token exactly once
 * (a single-use token must not be consumed twice by React's double-invoke).
 */

const KEY = "ipk_live_abc123.secret";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DeveloperPortal", () => {
  it("starts signup and shows the check-your-email state", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, status: "verification_sent", email: "dev@example.com" }, 202));
    render(<DeveloperPortal />);

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "dev@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send verification email/i }));

    await waitFor(() => expect(screen.getByText(/check your email/i)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v1/developers/register");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: "", email: "dev@example.com" });
  });

  it("signs in with a key and renders the one-time key with a warning", async () => {
    // GET /developers (sign-in) then POST /keys (create).
    fetchMock
      .mockResolvedValueOnce(json({ ok: true, developer: { id: "dev_1", name: "Acme", email: "dev@example.com", emailVerified: true, status: "active" }, keys: [] }))
      .mockResolvedValueOnce(json({ ok: true, key: KEY, keyId: "key_1", warning: "Store this key securely. It is shown once." }, 201))
      .mockResolvedValueOnce(json({ ok: true, developer: { id: "dev_1", name: "Acme", email: "dev@example.com", emailVerified: true, status: "active" }, keys: [{ id: "key_1", name: "New key", prefix: "ipk_live_abc123", environment: "live", status: "active", createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null }] }));

    render(<DeveloperPortal />);
    fireEvent.click(screen.getByRole("button", { name: /i have a key/i }));
    fireEvent.change(screen.getByPlaceholderText("ipk_live_…"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(screen.getByText(KEY)).toBeTruthy());
    expect(screen.getAllByText(/shown once/i).length).toBeGreaterThan(0);
  });

  it("reports a rejected key without crashing", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: { code: "unauthorized", message: "Invalid API key." } }, 401));
    render(<DeveloperPortal />);
    fireEvent.click(screen.getByRole("button", { name: /i have a key/i }));
    fireEvent.change(screen.getByPlaceholderText("ipk_live_…"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(screen.getByText(/not accepted/i)).toBeTruthy());
  });
});

describe("VerifyClient", () => {
  it("exchanges the URL token once and shows the key", async () => {
    window.history.replaceState({}, "", "/developer/verify?token=ipv_test");
    fetchMock.mockResolvedValueOnce(
      json({ ok: true, apiKey: KEY, developer: { email: "dev@example.com", emailVerifiedAt: new Date().toISOString() } }, 201),
    );

    render(<VerifyClient />);

    await waitFor(() => expect(screen.getByText(KEY)).toBeTruthy());
    // Single-use: exactly one exchange despite React's double-invoke.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v1/developers/verify");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token: "ipv_test" });
  });

  it("shows an honest error when the token is missing or rejected", async () => {
    window.history.replaceState({}, "", "/developer/verify");
    render(<VerifyClient />);
    await waitFor(() => expect(screen.getByText(/could not verify/i)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
