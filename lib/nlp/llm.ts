import type { ParseHint } from "./parser";

/**
 * Optional LLM enhancement for intent parsing.
 *
 * Design constraints (these are product rules, not preferences):
 *  - The LLM only ever *hints* at NLU fields. It can never supply a price, a
 *    route, a contract address, or a transaction, because none of those fields
 *    exist in the schema it fills. `sanitizePatch` drops anything unknown.
 *  - The deterministic parser is the authority; hints only fill gaps.
 *  - If the provider is not configured, times out, errors, or returns garbage,
 *    this returns `null` and the deterministic flow continues unchanged.
 *
 * Nothing here runs on the client, and no key is ever bundled into the browser:
 * only server-only env vars are read.
 */

const TIMEOUT_MS = 4500;

/**
 * The largest completion the intent extraction may produce. The schema is tiny
 * (four fields), so this is generous — but it must be a *bound*: the budget
 * reservation charges the worst case before the call, so an uncapped completion
 * would let a single request spend past the reservation. Kept in sync with the
 * budget guard's estimate.
 */
export const LLM_MAX_OUTPUT_TOKENS = 512;
/** The largest prompt we will send (the sentence plus a short system prompt). */
export const LLM_MAX_INPUT_CHARS = 2_000;
/**
 * A conservative upper bound on prompt tokens for one call (the capped user text
 * plus the fixed system prompt). The budget guard charges this worst case before
 * the call, so it must never under-estimate.
 */
export const LLM_MAX_INPUT_TOKENS_ESTIMATE = Math.ceil(LLM_MAX_INPUT_CHARS / 4) + 400;

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/** The provider config, or null when intent enhancement is not configured. */
export function llmConfig(): LlmConfig | null {
  const apiKey =
    process.env.INTENT_LLM_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const baseUrl =
    process.env.INTENT_LLM_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.INTENT_LLM_MODEL ?? "gpt-4o-mini";
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model };
}

export function llmEnabled(): boolean {
  return llmConfig() !== null;
}

/**
 * Ask the model to extract only NLU fields. Returns null on any failure so the
 * caller always has a deterministic fallback.
 *
 * `onUsage` (optional) receives the model + token counts so the caller can do
 * cost accounting. It never receives the prompt or the response text.
 */
export async function extractIntentHint(
  text: string,
  symbols: string[],
  onUsage?: (usage: { model: string; inputTokens: number; outputTokens: number }) => void | Promise<void>,
): Promise<ParseHint | null> {
  const cfg = llmConfig();
  if (!cfg) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const system = [
    "You extract structured payment fields from a single English sentence.",
    "Return ONLY a JSON object. No prose, no markdown.",
    'Schema: {"amount": string|null, "amountType": "USD_VALUE"|"TOKEN_AMOUNT"|null,',
    '"asset": string|null, "recipientName": string|null}.',
    'Amounts are strings of digits, e.g. "10" or "5.50".',
    "amountType is USD_VALUE when the amount is a dollar value ($10, 10 dollars)",
    "and TOKEN_AMOUNT when it is a token quantity (10 MON).",
    `asset must be one of these known symbols, exactly as written: ${symbols.join(", ")}.`,
    "If the user names an asset not in that list, set asset to null.",
    "recipientName is a human name only (e.g. \"John\"). Never output an address.",
    "Never output a price, a route, an address, or any other field.",
  ].join(" ");

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        // A hard bound on the completion: the budget guard reserves the worst
        // case before the call, so the provider must not be allowed to exceed it.
        max_tokens: LLM_MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: text.slice(0, LLM_MAX_INPUT_CHARS) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    // Token usage, when the provider reports it. Counts only — never content.
    const usage = json?.usage;
    if (onUsage) {
      // Awaited: the budget settlement must complete before this returns, so a
      // reservation can never be left held because the caller moved on.
      await onUsage({
        model: cfg.model,
        inputTokens: Number(usage?.prompt_tokens ?? 0) || 0,
        outputTokens: Number(usage?.completion_tokens ?? 0) || 0,
      });
    }
    const parsed = JSON.parse(content);
    return { patch: parsed, source: "llm" };
  } catch {
    // Provider down / timed out / malformed JSON: no hint, no failure.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
