"use client";

import { motion } from "framer-motion";
import type { AmountMode } from "@/lib/domain/intent";

const OPTIONS: { key: AmountMode; label: string; hint: string }[] = [
  { key: "recipient_receives", label: "Recipient receives", hint: "They get exactly this" },
  { key: "i_spend", label: "I spend", hint: "You spend exactly this" },
];

/** Makes it unmistakable whether you are specifying what you spend or what they receive. */
export function ModeToggle({
  value,
  onChange,
}: {
  value: AmountMode;
  onChange: (m: AmountMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Amount mode"
      className="relative grid grid-cols-2 gap-1 rounded-2xl border border-white/[0.07] bg-ink-900/60 p-1"
    >
      {OPTIONS.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.key)}
            className="relative rounded-xl px-3 py-2.5 text-center transition"
          >
            {active && (
              <motion.span
                layoutId="mode-pill"
                className="absolute inset-0 rounded-xl bg-white/[0.07] ring-1 ring-white/10"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <span className="relative block text-sm font-semibold text-white">{o.label}</span>
            <span className="relative block text-[11px] text-white/40">{o.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
