"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Bolt } from "@/components/ui/Icons";

/**
 * Hero. One idea, stated once: state the payment, review the route, send on
 * Monad. Restrained — a single accent, no gradient headline, no decorative
 * graphics — so the working composer below is the visual centre of the page.
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
        Payment infrastructure connecting payment intentions with blockchain execution.
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.1 }}
        className="mx-auto mt-5 max-w-xl text-pretty text-base leading-relaxed text-white/55 sm:text-lg"
      >
        State what the recipient should receive. Intent Pay determines which asset you spend, the
        route, and the transaction — then you approve it in your own wallet.
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

/** Three plain-language steps, used as the supporting explanation. */
export function HowItWorks() {
  const items = [
    { t: "You choose what they receive", d: "Recipient, exact amount, and token — that is your intent." },
    { t: "We find the route", d: "The system picks a funded asset you hold and the best route it can quote." },
    { t: "You confirm once", d: "You authorize a single prepared transaction; the recipient receives the token you asked for." },
  ];
  return (
    <section id="how" className="mx-auto max-w-4xl scroll-mt-24 px-5 pt-16">
      <div className="grid gap-3 sm:grid-cols-3">
        {items.map((it, i) => (
          <motion.div
            key={it.t}
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.35, delay: i * 0.05 }}
            className="card-flat p-4"
          >
            <span className="num text-xs font-bold text-mono-soft">0{i + 1}</span>
            <h3 className="mt-2 text-sm font-semibold text-white">{it.t}</h3>
            <p className="mt-1 text-xs leading-relaxed text-white/45">{it.d}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
