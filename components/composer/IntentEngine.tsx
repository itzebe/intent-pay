"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { formatAmount, formatUsd, isEvmAddress, shortAddress } from "@/lib/format";
import { useDebounced, useIntentEngine, type NlpAsset } from "@/lib/hooks/useIntentEngine";
import { usePaymentFlow } from "@/lib/hooks/usePayment";
import type { TokenConfig } from "@/lib/config/tokens";
import { TokenBadge } from "@/components/ui/TokenBadge";
import { Check, Sparkle, Spinner, Warning } from "@/components/ui/Icons";

/**
 * Natural-language Intent Engine — an *additional* interface layer.
 *
 * The sentence is part of the canonical intent (as provenance). Typing is
 * debounced, so a route request is only issued once the user pauses — never per
 * keystroke. Every request is id-guarded so a slow parse of an earlier sentence
 * can never overwrite a later one.
 *
 * Nothing here signs or executes: it collects recipient / amount / asset and
 * hands the completed fields to the canonical intent, which runs the same
 * quote → review → signing-guard flow.
 */
export function IntentEngine({ onPrefilled }: { onPrefilled?: () => void }) {
  const flow = usePaymentFlow();
  const engine = useIntentEngine(flow.intent.network, flow.balances);
  const [text, setText] = useState(flow.intent.text);
  const debouncedText = useDebounced(text, 450);
  const lastSubmittedRef = useRef<string>("");
  const result = engine.result;

  const examples = useMemo(() => ["Send $10", "Send 10 MON", "Send $10 worth of MON"], []);

  // Debounced auto-parse: the sentence drives the draft automatically after the
  // user finishes editing, without a request per keystroke.
  useEffect(() => {
    const v = debouncedText.trim();
    if (!v) return;
    if (v === lastSubmittedRef.current) return;
    lastSubmittedRef.current = v;
    engine.submit(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedText]);

  const onChangeText = (value: string) => {
    setText(value);
    // The raw instruction is canonical provenance. Editing it invalidates any
    // Review the user is looking at (the composer watches this field).
    flow.setText(value);
  };

  const send = (value: string) => {
    const v = value.trim();
    if (!v) return;
    setText(v);
    flow.setText(v);
    lastSubmittedRef.current = v;
    engine.submit(v);
  };

  // The engine reports a fully-specified intent: pre-fill the canonical intent,
  // which runs its own quote → review → signing-guard flow. No execution here.
  const applyToComposer = () => {
    if (!result?.compose) return;
    flow.prefillFromIntent({
      recipient: result.compose.recipient,
      receiveToken: result.compose.receiveToken,
      receiveAmountUsd: result.compose.receiveAmountUsd,
      amountMode: result.compose.amountMode,
      payToken: result.compose.sourceAsset,
      payTokenSource: result.compose.sourceAsset ? "intent" : undefined,
    });
    onPrefilled?.();
  };

  const state = result?.state;

  return (
    <div className="card-flat mt-4 overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkle className="h-4 w-4 text-mono-soft" />
          <span className="text-sm font-semibold text-white">Describe the payment</span>
        </div>
        <span className="chip text-[11px] text-white/50">
          Optional · {result?.llm ? "AI-assisted" : "On-device"}
        </span>
      </div>

      <div className="p-4">
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => onChangeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send(text);
            }}
            placeholder='e.g. "Send $10 worth of MON to 0x…"'
            spellCheck={false}
            autoComplete="off"
            aria-label="Describe a payment in plain English"
            className="field flex-1 text-[13px]"
          />
          <button onClick={() => send(text)} disabled={!text.trim() || engine.loading} className="btn-primary shrink-0 px-4">
            {engine.loading ? <Spinner className="h-4 w-4 animate-spin" /> : "Ask"}
          </button>
        </div>

        {!result && !engine.loading && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {examples.map((ex) => (
              <button
                key={ex}
                onClick={() => send(ex)}
                className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-white/55 transition hover:border-white/20 hover:text-white/80"
              >
                {ex}
              </button>
            ))}
          </div>
        )}

        <AnimatePresence mode="wait">
          {engine.error && (
            <motion.p
              key="err"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="mt-3 flex items-start gap-2 text-xs text-amber-200/90"
            >
              <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {engine.error}
            </motion.p>
          )}

          {result && (
            <motion.div key="result" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3.5">
              <div className="rounded-2xl border border-white/[0.06] bg-ink-900/50 p-3">
                <div className="flex flex-wrap gap-1.5">
                  <Tag label={amountTag(result)} />
                  {result.draft.asset && <Tag label={`Asset · ${result.draft.asset}`} />}
                  {result.draft.recipientAddress && <Tag label={`To · ${shortAddress(result.draft.recipientAddress, 4)}`} />}
                  {result.draft.recipientName && !result.draft.recipientAddress && (
                    <Tag label={`Name · ${result.draft.recipientName}`} />
                  )}
                </div>

                {result.clarification.expect !== "none" && (
                  <p className="mt-2.5 text-sm text-white/80">{result.clarification.question}</p>
                )}

                {state === "NEEDS_ASSET" && result.assets.length > 0 && (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {result.assets.slice(0, 6).map((a) => (
                      <button
                        key={a.symbol}
                        onClick={() => send(a.symbol)}
                        className="flex items-center gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-2.5 text-left transition hover:border-white/20 hover:bg-white/[0.05]"
                      >
                        <TokenBadge token={assetToToken(a)} size={26} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-white">{a.symbol}</span>
                          <span className="block truncate text-[11px] text-white/40">
                            {a.held ? `Balance ${formatAmount(a.balance ?? "0")}` : "Via conversion"}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {state === "NEEDS_RECIPIENT" && <AddressPrompt onSubmit={(addr) => send(addr)} />}

                {result.error && (
                  <p className="mt-2.5 flex items-start gap-2 text-xs text-amber-200/90">
                    <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {result.error.message}
                  </p>
                )}

                {result.compose && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.04] px-3 py-2.5">
                      <div className="flex items-center gap-2 text-xs text-white/70">
                        <Check className="h-4 w-4 text-emerald-300" />
                        <span>
                          {result.handoff?.summary || "Ready"} ·{" "}
                          <span className="font-mono">{shortAddress(result.compose.recipient, 4)}</span>
                        </span>
                      </div>
                      {result.handoff?.price != null && (
                        <span className="num text-[11px] text-white/40">
                          1 {result.draft.asset} ≈ {formatUsd(result.handoff.price)}
                        </span>
                      )}
                    </div>
                    <button onClick={applyToComposer} className="btn-primary mt-2.5 w-full">
                      Continue to payment
                    </button>
                  </div>
                )}
              </div>

              {result.llm && (
                <p className="mt-2 text-[11px] text-white/30">
                  Language hints are AI-assisted. Prices, routes and amounts always come from live
                  on-chain data — never the model.
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Adapt the API asset shape to the TokenConfig a TokenBadge expects. */
function assetToToken(a: NlpAsset): TokenConfig {
  return {
    symbol: a.symbol,
    name: a.name,
    address: a.address as `0x${string}`,
    decimals: a.decimals,
    native: a.native,
    fallbackUsd: 0,
    tint: a.tint,
  };
}

function amountTag(result: {
  draft: { amount: string | null; amountType: string | null; asset: string | null };
}): string {
  if (!result.draft.amount) return "Amount · missing";
  if (result.draft.amountType === "USD_VALUE") return `$${result.draft.amount}`;
  return `${result.draft.amount} ${result.draft.asset ?? ""}`.trim();
}

function Tag({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-white/65">
      {label}
    </span>
  );
}

/** Only accepts a syntactically valid EVM address; never guesses one. */
function AddressPrompt({ onSubmit }: { onSubmit: (addr: string) => void }) {
  const [value, setValue] = useState("");
  const valid = isEvmAddress(value.trim());
  return (
    <div className="mt-2.5 flex gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && valid) onSubmit(value.trim());
        }}
        placeholder="0x…  recipient wallet on Monad"
        spellCheck={false}
        autoComplete="off"
        aria-label="Recipient address"
        className="field flex-1 font-mono text-[13px]"
      />
      <button onClick={() => valid && onSubmit(value.trim())} disabled={!valid} className="btn-primary shrink-0 px-4">
        Use
      </button>
    </div>
  );
}
