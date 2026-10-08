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
import { getRoutingProvider } from "@/lib/providers";
import type { Balance } from "@/lib/domain/intent";
import { splitPayment } from "@/lib/domain/partialBalance";
import {
  ensureCatalog,
  resolveSymbol,
  resolveToken,
  type AmbiguousMatch,
} from "@/lib/server/discovery";
import { applyResolvedAsset, mergeDraft, planFromDraft, planFromText } from "@/lib/nlp/engine";
import { draftToHandoff, type ComposeHandoff } from "@/lib/nlp/handoff";
import { llmEnabled, extractIntentHint } from "@/lib/nlp/llm";
import {
  deriveState,
  missingField,
  emptyIntent,
  type ParsedPaymentIntent,
} from "@/lib/nlp/schema";

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
  const network: MonadNetwork = "mainnet";
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

    // Conversational continuation: the client returns the draft collected so
    // far, and the newest message is merged into it (newest explicit values
    // win) so a follow-up answer or a corrected amount both behave correctly.
    const activeDraft = parseDraft(body?.draft);
    if (activeDraft) {
      // The newest message's explicit values (amount, asset, address, name)
      // overwrite the collected draft, so restating a field corrects it instead
      // of being silently dropped. A message carrying none of them — an asset
      // pick ("MON"), an address answer, or a bare follow-up — leaves the
      // already-collected fields untouched.
      plan = planFromDraft(mergeDraft(activeDraft, plan.draft));
    }

    const assets = buildAssets(balances);
    let missing = missingField(plan.draft);

    // ---- Live resolution of a named-but-unknown ticker ---------------------
    // "Send 100 NEWCOIN" names an asset the catalog may not know. Resolve it
    // live; if several contracts share the ticker, ask the user to pick rather
    // than guessing. A successful resolution replaces the query with a concrete
    // asset so the rest of the pipeline runs unchanged.
    let resolutionPayload: Record<string, unknown> | null = null;
    if (!missing && plan.draft.assetQuery && !plan.draft.asset) {
      const resolution = resolveSymbol(plan.draft.assetQuery, network);
      resolutionPayload = resolutionForPayload(resolution);
      if (resolution.status === "resolved") {
        const next = applyResolvedAsset(plan.draft, resolution.token.symbol, symbols);
        plan = { ...plan, draft: next, state: deriveState(next) };
        missing = missingField(plan.draft);
      } else {
        // Ambiguous or unknown: no quote, no review — the user must clarify.
        return NextResponse.json({
          ok: true,
          network,
          llm: llmEnabled(),
          state: plan.state,
          missing,
          draft: plan.draft,
          clarification: plan.clarification,
          understood: plan.understood,
          assets,
          resolution: resolutionPayload,
          compose: null,
          handoff: null,
          error: resolutionForError(resolution),
        });
      }
    }

    const payload: Record<string, unknown> = {
      ok: true,
      network,
      llm: llmEnabled(),
      state: plan.state,
      missing,
      draft: plan.draft,
      clarification: plan.clarification,
      understood: plan.understood,
      assets,
      resolution: resolutionPayload,
      // The wallet's real holding of the requested asset + how much is missing,
      // so the chat can show "balance 4.2, need 20.8 more" from real data.
      holding: null as Record<string, unknown> | null,
      compose: null as ComposeHandoff | null,
      handoff: null as { summary: string; price: number | null } | null,
      error: null as { code: string; message: string } | null,
    };

    // Only when the intent is fully specified do we touch live pricing. Until
    // then the user is still answering questions — no quote, no review.
    if (!missing) {
      const resolved = await resolveToken(plan.draft.asset!, network);
      if (resolved) {
        payload.holding = computeHolding(plan.draft, resolved.token, balances);
      }
      if (!resolved) {
        payload.error = {
          code: "unsupported_token",
          message: `${plan.draft.asset} isn't currently available through this payment route.`,
        };
      } else {
        const provider = getRoutingProvider(network);
        const price = await provider.priceUsd(resolved.token, network);
        const priceUsd = price.usd > 0 ? price.usd : null;
        // The "N A worth of B" form denominates the amount in the source asset,
        // so it needs the source price too. We fetch it from live data only.
        let sourcePriceUsd: number | null = null;
        if (plan.draft.sourceAsset) {
          const sourceResolved = await resolveToken(plan.draft.sourceAsset, network);
          if (sourceResolved) {
            const sp = await provider.priceUsd(sourceResolved.token, network);
            sourcePriceUsd = sp.usd > 0 ? sp.usd : null;
          }
        }
        const handoff = draftToHandoff(plan.draft, priceUsd, sourcePriceUsd);
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
  const base = emptyIntent("mainnet");
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const amountType = r.amountType === "USD_VALUE" || r.amountType === "TOKEN_AMOUNT" ? r.amountType : null;
  return {
    ...base,
    amount: str(r.amount),
    amountType: amountType ?? base.amountType,
    asset: str(r.asset),
    assetQuery: str(r.assetQuery),
    sourceAsset: str(r.sourceAsset),
    recipientAddress: str(r.recipientAddress),
    recipientName: str(r.recipientName),
    status: base.status,
  };
}

/**
 * The wallet's real holding of the requested asset, plus how much more is
 * needed. Only a token-amount instruction yields a shortfall (a USD-value
 * instruction is expressed as a dollar target, not a token quantity). Returns
 * null when we cannot compare (no balance entry) — never a guessed number.
 */
function computeHolding(
  draft: ParsedPaymentIntent,
  token: TokenConfig,
  balances: Balance[],
): Record<string, unknown> | null {
  const bal = balances.find(
    (b) =>
      (b.token?.address ?? "").toLowerCase() === token.address.toLowerCase() ||
      (b.token?.symbol ?? "").toLowerCase() === token.symbol.toLowerCase(),
  );
  const held = bal?.amount ?? "0";
  if (draft.amountType !== "TOKEN_AMOUNT" || !draft.amount) {
    return { token: token.symbol, address: token.address, held, needed: null, shortfall: null };
  }
  const split = splitPayment(draft.amount, held, token.decimals);
  return {
    token: token.symbol,
    address: token.address,
    held,
    needed: draft.amount,
    shortfall: split.mode === "direct" ? null : split.shortfall,
    mode: split.mode,
  };
}

/** The resolution outcome for the client, or null when none was attempted. */
function resolutionForPayload(
  resolution: ReturnType<typeof resolveSymbol>,
): Record<string, unknown> | null {
  if (resolution.status === "resolved") {
    return {
      status: "resolved",
      symbol: resolution.token.symbol,
      address: resolution.token.address,
      decimals: resolution.token.decimals,
      name: resolution.token.name,
      listed: resolution.listed,
      source: resolution.source,
    };
  }
  if (resolution.status === "ambiguous") {
    return {
      status: "ambiguous",
      query: resolution.query,
      matches: resolution.matches.map((m: AmbiguousMatch) => ({
        address: m.address,
        symbol: m.symbol,
        name: m.name,
        decimals: m.decimals,
        listed: m.listed,
        source: m.source,
        logoURI: m.logoURI,
      })),
    };
  }
  return { status: "not_found", query: resolution.query };
}

/**
 * The honest, non-fatal error for a failed resolution: never a quote, never a
 * guess. The client asks the user to pick a contract or paste an address.
 */
function resolutionForError(
  resolution: ReturnType<typeof resolveSymbol>,
): { code: string; message: string } | null {
  if (resolution.status === "ambiguous") {
    return {
      code: "ambiguous_token",
      message: `Several Monad tokens are named ${resolution.query}. Choose the exact one (or paste its contract address).`,
    };
  }
  if (resolution.status === "not_found") {
    return {
      code: "unsupported_token",
      message: `We couldn't find a Monad token called ${resolution.query}. Paste its contract address if it launched recently.`,
    };
  }
  return null;
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
