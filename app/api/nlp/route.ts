import { NextResponse } from "next/server";
import type { MonadNetwork } from "@/lib/config/chains";
import {
  allTokens,
  getToken,
  getTokenByAddress,
  SEED_TOKENS,
  tintForAddress,
  type TokenConfig,
} from "@/lib/config/tokens";
import { getRoutingProvider, type AppMode } from "@/lib/providers";
import type { Balance } from "@/lib/domain/intent";
import { ensureCatalog, resolveToken } from "@/lib/server/discovery";
import { planFromDraft, planFromText } from "@/lib/nlp/engine";
import { draftToHandoff, type ComposeHandoff } from "@/lib/nlp/handoff";
import { llmEnabled, extractIntentHint } from "@/lib/nlp/llm";
import { missingField, emptyIntent, type ParsedPaymentIntent } from "@/lib/nlp/schema";

export const dynamic = "force-dynamic";

/**
 * Natural-language Intent Engine endpoint.
 *
 * Pipeline (all deterministic except the optional LLM hint):
 *   text -> deterministic parser -> [optional LLM gap-fill] -> strict draft
 *        -> state machine -> clarification OR live-data enrichment
 *
 * Nothing financial is produced here except *reads* from the existing price and
 * token infrastructure. No transaction, no calldata, no signing — the request
 * merely decides what the existing composer should be pre-filled with.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "provider_error", message: "Invalid request." },
      { status: 400 },
    );
  }

  const text = typeof body?.text === "string" ? body.text : "";
  const mode: AppMode = body?.mode === "live" ? "live" : "demo";
  const network: MonadNetwork = body?.network === "testnet" ? "testnet" : "mainnet";
  const balances: Balance[] = Array.isArray(body?.balances) ? (body.balances as Balance[]) : [];

  if (!text.trim()) {
    return NextResponse.json(
      { ok: false, code: "invalid_amount", message: "Tell us what you'd like to send." },
      { status: 400 },
    );
  }

  try {
    await ensureCatalog(network);
    const symbols = allTokens().map((t) => t.symbol);

    // Deterministic parse is always the authority. The LLM may only fill gaps.
    const hint = llmEnabled() ? await extractIntentHint(text, symbols) : null;
    let plan = planFromText(text, { symbols, network, hint });

    // Conversational slot answers: when the client is answering a follow-up
    // ("MON" to "which asset?", or an address to "which address?"), the draft
    // is authoritative for everything already collected — the latest message
    // only supplies the missing field.
    const activeDraft = parseDraft(body?.draft);
    if (activeDraft) {
      if (plan.draft.recipientAddress && !activeDraft.recipientAddress) {
        activeDraft.recipientAddress = plan.draft.recipientAddress;
      }
      if (!activeDraft.amount && plan.draft.amount) {
        activeDraft.amount = plan.draft.amount;
        activeDraft.amountType = plan.draft.amountType;
      }
      // The parser only fills an asset when the message clearly names one; a
      // bare symbol answer ("MON") is exactly that. A fresh amount left the
      // existing asset choice in place.
      if (plan.draft.asset) activeDraft.asset = plan.draft.asset;
      if (plan.draft.recipientName) activeDraft.recipientName = plan.draft.recipientName;
      plan = planFromDraft(activeDraft);
    }

    const assets = buildAssets(balances);
    const missing = missingField(plan.draft);

    const payload: Record<string, unknown> = {
      ok: true,
      mode,
      network,
      llm: llmEnabled(),
      state: plan.state,
      missing,
      draft: plan.draft,
      clarification: plan.clarification,
      understood: plan.understood,
      assets,
      compose: null as ComposeHandoff | null,
      handoff: null as { summary: string; price: number | null } | null,
      error: null as { code: string; message: string } | null,
    };

    // Only when the intent is fully specified do we touch live pricing. Until
    // then the user is still answering questions — no quote, no review.
    if (!missing) {
      const resolved = await resolveToken(plan.draft.asset!, network);
      if (!resolved) {
        payload.error = {
          code: "unsupported_token",
          message: `${plan.draft.asset} isn't currently available through this payment route.`,
        };
      } else {
        const provider = getRoutingProvider(mode, network);
        const price = await provider.priceUsd(resolved.token, network);
        const priceUsd = price.usd > 0 ? price.usd : null;
        const handoff = draftToHandoff(plan.draft, priceUsd);
        if (handoff.ok) {
          payload.compose = handoff.compose;
          payload.handoff = { summary: handoff.summary, price: priceUsd };
        } else {
          payload.error = { code: "price_unavailable", message: handoff.message };
        }
      }
    }

    return NextResponse.json(payload);
  } catch (err) {
    // The AI/NLP layer must never break the normal payment flow: return a
    // structured, non-fatal error the client can fall back from.
    return NextResponse.json(
      {
        ok: false,
        code: "provider_error",
        message: (err as Error)?.message ?? "The intent engine is unavailable.",
      },
      { status: 200 },
    );
  }
}

/** Normalise a client-supplied draft; unknown fields are dropped. */
function parseDraft(raw: unknown): ParsedPaymentIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const base = emptyIntent(r.network === "testnet" ? "testnet" : "mainnet");
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const amountType = r.amountType === "USD_VALUE" || r.amountType === "TOKEN_AMOUNT" ? r.amountType : null;
  return {
    ...base,
    amount: str(r.amount),
    amountType: amountType ?? base.amountType,
    asset: str(r.asset),
    recipientAddress: str(r.recipientAddress),
    recipientName: str(r.recipientName),
    status: base.status,
  };
}

export type NlpAsset = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  native: boolean;
  tint: string;
  /** The wallet reports a non-zero balance for this asset. */
  held: boolean;
  balance?: string;
  usd?: number;
  /** The requested asset must be obtained via the routing layer. */
  requiresSwap: boolean;
};

/** Build the asset chooser options from real data only. */
function buildAssets(balances: Balance[]): NlpAsset[] {
  const bySymbol = new Map<string, TokenConfig>();
  const add = (t: TokenConfig) => {
    if (t?.symbol && !bySymbol.has(t.symbol.toLowerCase())) bySymbol.set(t.symbol.toLowerCase(), t);
  };

  // Real holdings first, but normalise each balance token against the registry:
  // the client sends a reduced token (symbol + address) and may omit display
  // metadata, so we resolve the full config before it reaches the UI.
  for (const b of balances) {
    const full =
      getTokenByAddress(b.token?.address ?? "") ??
      getToken(b.token?.symbol ?? "") ??
      normalizeBalanceToken(b.token);
    add(full);
  }
  for (const t of SEED_TOKENS) add(t);
  for (const t of allTokens().slice(0, 16)) add(t);

  const held = new Map(
    balances
      .filter((b) => b.usd > 0 && b.token?.symbol)
      .map((b) => [b.token.symbol.toLowerCase(), b]),
  );

  return [...bySymbol.values()].map((t) => {
    const b = held.get(t.symbol.toLowerCase());
    return {
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      decimals: t.decimals,
      native: Boolean(t.native),
      tint: t.tint,
      held: Boolean(b),
      balance: b?.amount,
      usd: b?.usd,
      // Not held (or unknown) means the asset must be obtained by routing —
      // which is exactly what the existing optimizer/quote layer does.
      requiresSwap: !b,
    };
  });
}

/** Rebuild a usable TokenConfig from a reduced balance token the client sent. */
function normalizeBalanceToken(token: Balance["token"] | undefined): TokenConfig {
  const address = (token?.address ?? "0x0") as `0x${string}`;
  return {
    symbol: token?.symbol ?? "UNKNOWN",
    name: token?.symbol ?? "Unknown token",
    address,
    decimals: token?.decimals ?? 18,
    native: Boolean(token?.native),
    fallbackUsd: 0,
    tint: tintForAddress(address),
  };
}
