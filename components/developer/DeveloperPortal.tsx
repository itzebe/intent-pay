"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Spinner, Warning } from "@/components/ui/Icons";

/**
 * The self-service developer portal.
 *
 * Two jobs: create an account (email → verification link → first API key) and
 * manage existing keys. It is a thin client of `/api/v1/developers*` — the same
 * public API an integrator uses — so it cannot drift from the documented
 * contract, and it holds the operator's own key in this browser only.
 *
 * The one-time API key is shown here and nowhere else; it is never persisted by
 * the portal (the developer stores it), which is why it is displayed with an
 * explicit "shown once" warning rather than saved.
 */

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  environment: string;
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type Account = {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  status: string;
};

const STORAGE_KEY = "intentpay.developer.apiKey";

async function call(path: string, init?: RequestInit & { key?: string }): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const { key, ...rest } = init ?? {};
  const res = await fetch(`/api/v1${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(rest.headers ?? {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function messageOf(body: Record<string, unknown>, fallback: string): string {
  const err = body?.error as { message?: string } | undefined;
  return err?.message ?? (typeof body?.message === "string" ? body.message : fallback);
}

export function DeveloperPortal() {
  const [tab, setTab] = useState<"register" | "signin">("register");

  // Register flow
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  // Sign-in flow
  const [apiKey, setApiKey] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [signinError, setSigninError] = useState<string | null>(null);

  // Dashboard
  const [account, setAccount] = useState<Account | null>(null);
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyWarning, setKeyWarning] = useState<string | null>(null);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setApiKey(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const load = useCallback(async (key: string) => {
    const res = await call("/developers", { key });
    if (!res.ok) return false;
    setAccount(res.body.developer as Account);
    setKeys((res.body.keys as ApiKeyRow[]) ?? []);
    return true;
  }, []);

  const register = useCallback(async () => {
    setRegisterError(null);
    setRegistering(true);
    try {
      const res = await call("/developers/register", { method: "POST", body: JSON.stringify({ name, email }) });
      if (!res.ok) {
        setRegisterError(messageOf(res.body, "Could not start signup."));
        return;
      }
      setSentTo((res.body.email as string) ?? email);
      setResent(Boolean(res.body.resent));
    } finally {
      setRegistering(false);
    }
  }, [name, email]);

  const resend = useCallback(async () => {
    setRegisterError(null);
    setRegistering(true);
    try {
      const res = await call("/developers/resend", { method: "POST", body: JSON.stringify({ email: sentTo ?? email }) });
      if (!res.ok) {
        setRegisterError(messageOf(res.body, "Could not resend the email."));
        return;
      }
      setResent(true);
    } finally {
      setRegistering(false);
    }
  }, [email, sentTo]);

  const signIn = useCallback(async () => {
    setSigninError(null);
    setSigningIn(true);
    try {
      const ok = await load(apiKey.trim());
      if (!ok) {
        setSigninError("That API key was not accepted.");
        return;
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, apiKey.trim());
      } catch {
        /* ignore */
      }
    } finally {
      setSigningIn(false);
    }
  }, [apiKey, load]);

  const createKey = useCallback(async () => {
    setKeyWarning(null);
    setNewKey(null);
    const res = await call("/developers/keys", { method: "POST", key: apiKey, body: JSON.stringify({ action: "create", name: "New key" }) });
    if (!res.ok) {
      setKeyWarning(messageOf(res.body, "Could not create a key."));
      return;
    }
    setNewKey(res.body.key as string);
    setKeyWarning(res.body.warning as string);
    await load(apiKey);
  }, [apiKey, load]);

  const rotate = useCallback(
    async (keyId: string) => {
      setBusyKeyId(keyId);
      setKeyWarning(null);
      setNewKey(null);
      try {
        const res = await call("/developers/keys", { method: "POST", key: apiKey, body: JSON.stringify({ action: "rotate", keyId }) });
        if (!res.ok) {
          setKeyWarning(messageOf(res.body, "Could not rotate the key."));
          return;
        }
        setNewKey(res.body.key as string);
        setKeyWarning(res.body.warning as string);
        await load(apiKey);
      } finally {
        setBusyKeyId(null);
      }
    },
    [apiKey, load],
  );

  const revoke = useCallback(
    async (keyId: string) => {
      setBusyKeyId(keyId);
      setKeyWarning(null);
      try {
        const res = await call("/developers/keys", { method: "POST", key: apiKey, body: JSON.stringify({ action: "revoke", keyId }) });
        if (!res.ok) {
          setKeyWarning(messageOf(res.body, "Could not revoke the key."));
          return;
        }
        await load(apiKey);
      } finally {
        setBusyKeyId(null);
      }
    },
    [apiKey, load],
  );

  const copyKey = useCallback(async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, [newKey]);

  // ---- Dashboard -----------------------------------------------------------
  if (account) {
    return (
      <div className="space-y-6">
        <div className="card-flat p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-white">{account.name}</div>
              <div className="mt-0.5 text-xs text-white/50">
                {account.email ?? "operator-provisioned account"}
              </div>
            </div>
            <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200">
              {account.status}
            </span>
          </div>
        </div>

        {newKey && (
          <div className="card-flat border border-amber-400/30 bg-amber-400/[0.04] p-5">
            <div className="flex items-center gap-2 text-amber-200">
              <Warning className="h-4 w-4" />
              <span className="text-xs font-semibold">Your new API key — shown once</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg bg-black/40 px-3 py-2 font-mono text-xs text-white/80">
                {newKey}
              </code>
              <button onClick={copyKey} className="btn-ghost !px-3 !py-2" type="button">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-white/50">
              {keyWarning ?? "Store this key securely. It cannot be retrieved again."}
            </p>
          </div>
        )}

        {keyWarning && !newKey && (
          <div className="card-flat border border-red-400/30 bg-red-400/[0.04] p-4 text-xs text-red-200">
            {keyWarning}
          </div>
        )}

        <div className="card-flat overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
            <span className="text-xs font-semibold text-white/70">API keys</span>
            <button onClick={createKey} className="btn-ghost !px-3 !py-1.5 text-xs" type="button">
              Create key
            </button>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="text-white/40">
              <tr>
                <th className="px-5 py-2 font-medium">Name</th>
                <th className="px-5 py-2 font-medium">Prefix</th>
                <th className="px-5 py-2 font-medium">Env</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Last used</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-white/[0.04] text-white/70">
                  <td className="px-5 py-2.5">{k.name}</td>
                  <td className="px-5 py-2.5 font-mono text-white/50">{k.prefix}…</td>
                  <td className="px-5 py-2.5">{k.environment}</td>
                  <td className="px-5 py-2.5">
                    <span className={k.status === "active" ? "text-emerald-200" : "text-white/40"}>{k.status}</span>
                  </td>
                  <td className="px-5 py-2.5 text-white/40">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "never"}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {k.status === "active" && (
                      <span className="inline-flex gap-2">
                        <button onClick={() => rotate(k.id)} disabled={busyKeyId === k.id} className="text-mono-soft hover:underline" type="button">
                          Rotate
                        </button>
                        <button onClick={() => revoke(k.id)} disabled={busyKeyId === k.id} className="text-red-300 hover:underline" type="button">
                          Revoke
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-6 text-center text-white/40">
                    No keys yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ---- Register / sign-in --------------------------------------------------
  return (
    <div className="card-flat p-6">
      <div className="mb-5 flex gap-2">
        <button
          onClick={() => setTab("register")}
          className={tab === "register" ? "btn-primary !px-4 !py-2 text-xs" : "btn-ghost !px-4 !py-2 text-xs"}
          type="button"
        >
          Create an account
        </button>
        <button
          onClick={() => setTab("signin")}
          className={tab === "signin" ? "btn-primary !px-4 !py-2 text-xs" : "btn-ghost !px-4 !py-2 text-xs"}
          type="button"
        >
          I have a key
        </button>
      </div>

      {tab === "register" && (
        <div className="space-y-4">
          {sentTo ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-emerald-200">
                <Check className="h-4 w-4" />
                <span className="text-sm font-semibold">Check your email</span>
              </div>
              <p className="text-sm leading-relaxed text-white/55">
                We sent a verification link to <span className="text-white/80">{sentTo}</span>. Open it to
                receive your API key. The link expires in 24 hours and can be used once.
              </p>
              {resent && <p className="text-xs text-white/40">A new link was sent.</p>}
              <button onClick={resend} disabled={registering} className="btn-ghost !px-4 !py-2 text-xs" type="button">
                {registering ? "Sending…" : "Resend email"}
              </button>
              {registerError && <p className="text-xs text-red-300">{registerError}</p>}
            </div>
          ) : (
            <>
              <label className="block">
                <span className="text-xs font-medium text-white/60">Name (optional)</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-app"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-mono/60"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-white/60">Email</span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  type="email"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-mono/60"
                />
              </label>
              <button onClick={register} disabled={registering || !email} className="btn-primary w-full !py-2.5 text-sm" type="button">
                {registering ? <Spinner className="h-4 w-4" /> : "Send verification email"}
              </button>
              {registerError && <p className="text-xs text-red-300">{registerError}</p>}
              <p className="text-[11px] leading-relaxed text-white/40">
                We email you a one-time link. Your first API key is issued only after you open it, so an
                address you do not control can never obtain a credential.
              </p>
            </>
          )}
        </div>
      )}

      {tab === "signin" && (
        <div className="space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-white/60">API key</span>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="ipk_live_…"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white outline-none focus:border-mono/60"
            />
          </label>
          <button onClick={signIn} disabled={signingIn || !apiKey} className="btn-primary w-full !py-2.5 text-sm" type="button">
            {signingIn ? <Spinner className="h-4 w-4" /> : "Sign in"}
          </button>
          {signinError && <p className="text-xs text-red-300">{signinError}</p>}
          <p className="text-[11px] leading-relaxed text-white/40">
            Your key stays in this browser. It is never sent anywhere except the Intent Pay API.
          </p>
        </div>
      )}
    </div>
  );
}
