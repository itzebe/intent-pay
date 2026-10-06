"use client";

import { motion } from "framer-motion";
import { Warning } from "@/components/ui/Icons";

/** Exact-payment protection banner with a one-tap correction. */
export function MismatchAlert({
  intended,
  current,
  difference,
  onCorrect,
}: {
  intended: string;
  current: string;
  difference: string;
  onCorrect: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-amber-300">
            <Warning className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-100">
              Payment exceeds your intended amount
            </p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-white/45">Intended</span>
              <span className="num text-right text-white/80">{intended}</span>
              <span className="text-white/45">Current</span>
              <span className="num text-right text-white/80">{current}</span>
              <span className="text-white/45">Difference</span>
              <span className="num text-right font-semibold text-amber-200">{difference}</span>
            </div>
            <button onClick={onCorrect} className="btn-ghost mt-3 w-full py-2.5 text-xs">
              Correct to {intended}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
