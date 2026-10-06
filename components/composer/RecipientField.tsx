"use client";

import { motion } from "framer-motion";
import { isEvmAddress, shortAddress } from "@/lib/format";
import { Check, Warning } from "@/components/ui/Icons";

export function RecipientField({
  value,
  onChange,
  onValidChange,
}: {
  value: string;
  onChange: (v: string) => void;
  onValidChange?: (valid: boolean) => void;
}) {
  const trimmed = value.trim();
  const valid = isEvmAddress(trimmed);
  const touched = trimmed.length > 0;
  const invalid = touched && !valid;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="label" htmlFor="recipient">
          Who should receive it?
        </label>
        {touched && (
          <motion.span
            initial={{ opacity: 0, x: 4 }}
            animate={{ opacity: 1, x: 0 }}
            className={`inline-flex items-center gap-1 text-[11px] font-medium ${
              valid ? "text-emerald-300/80" : "text-amber-300/80"
            }`}
          >
            {valid ? <Check className="h-3 w-3" /> : <Warning className="h-3 w-3" />}
            {valid ? shortAddress(trimmed) : "Not a valid address"}
          </motion.span>
        )}
      </div>
      <div className="relative">
        <input
          id="recipient"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            onValidChange?.(isEvmAddress(e.target.value.trim()));
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder="0x…  recipient wallet on Monad"
          className={`field pr-11 font-mono text-[13px] ${invalid ? "border-amber-400/40" : ""}`}
          aria-invalid={invalid}
          inputMode="text"
        />
        {valid && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-300">
            <Check className="h-4 w-4" />
          </span>
        )}
      </div>
    </div>
  );
}
