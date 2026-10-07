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
 */
export async function extractIntentHint(
  text: string,
  symbols: string[],
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
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = JSON.parse(content);
    return { patch: parsed, source: "llm" };
  } catch {
    // Provider down / timed out / malformed JSON: no hint, no failure.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
