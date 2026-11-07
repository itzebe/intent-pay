"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Bolt } from "@/components/ui/Icons";

/**
 * Hero. One idea, stated plainly: say who gets what, and Intent Pay works out
 * how — then you approve it in your own wallet. Restrained: a single accent, no
 * gradient headline, no decorative graphics, so the working composer below is
 * the visual centre of the page.
 */
export function Hero({ onTry }: { onTry: () => void }) {
  return (
    <section className="mx-auto max-w-3xl px-5 pt-14 text-center sm:pt-20">
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-xs text-white/55"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" aria-hidden="true" />
        Live on Monad Mainnet
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.05 }}
        className="text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl"
      >
        Pay anyone the token they asked for, from whatever you already hold.
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.1 }}
        className="mx-auto mt-5 max-w-xl text-pretty text-base leading-relaxed text-white/60 sm:text-lg"
      >
        State the payment — who receives, how much, which token. Intent Pay finds the route on
        Monad, prepares one transaction, and you approve it in your own wallet. You keep your keys;
        settlement is verified on-chain.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.15 }}
        className="mt-7 flex flex-wrap items-center justify-center gap-3"
      >
        <button onClick={onTry} className="btn-primary">
          <Bolt className="h-4 w-4" /> Try the payment experience
        </button>
        <Link href="/product" className="btn-ghost">
          How it works <ArrowRight className="h-4 w-4" />
        </Link>
      </motion.div>
    </section>
  );
}

