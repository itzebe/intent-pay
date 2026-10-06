"use client";

import { motion } from "framer-motion";
import { ArrowDown, Bolt, Sparkle } from "@/components/ui/Icons";

/** Hero communicates the entire idea immediately — no long marketing page. */
export function Hero({ onTry }: { onTry: () => void }) {
  return (
    <section className="mx-auto max-w-3xl px-5 pt-10 text-center sm:pt-16">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-xs text-white/60"
      >
        <Sparkle className="h-3.5 w-3.5 text-mono-soft" />
        Intent-based payments for Monad
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.05 }}
        className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl"
      >
        Pay in what you have.
        <br />
        <span className="bg-gradient-to-r from-mono-soft via-white to-accent-cyan bg-clip-text text-transparent">
          Send what they need.
        </span>
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.12 }}
        className="mx-auto mt-5 max-w-xl text-pretty text-base leading-relaxed text-white/55 sm:text-lg"
      >
        Choose what the recipient should receive. We handle the token conversion and the
        transaction details underneath.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.18 }}
        className="mt-7 flex flex-wrap items-center justify-center gap-3"
      >
        <button onClick={onTry} className="btn-primary">
          <Bolt className="h-4 w-4" /> Try the experience
        </button>
        <a href="#how" className="btn-ghost">
          How it works <ArrowDown className="h-4 w-4" />
        </a>
      </motion.div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="mt-4 text-xs text-white/35"
      >
        Pay with USDT. They receive SOL. No swaps to think about.
      </motion.p>
    </section>
  );
}

/** Three plain-language steps, used as the supporting explanation. */
export function HowItWorks() {
  const items = [
    { t: "You choose what they receive", d: "Recipient, exact amount, and token — that's your intent." },
    { t: "We find the route", d: "The system picks the best asset you hold and the best Monad route." },
    { t: "They get exactly that", d: "You confirm once. The recipient receives the token they need." },
  ];
  return (
    <section id="how" className="mx-auto max-w-4xl scroll-mt-24 px-5 pt-14">
      <div className="grid gap-3 sm:grid-cols-3">
        {items.map((it, i) => (
          <motion.div
            key={it.t}
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.4, delay: i * 0.06 }}
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
