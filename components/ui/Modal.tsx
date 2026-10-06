"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect } from "react";

export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = 440,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  maxWidth?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <button
            aria-label="Close"
            onClick={onClose}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="relative w-full overflow-hidden rounded-t-3xl border border-white/10 bg-ink-850/95 shadow-2xl sm:rounded-3xl"
            style={{ maxWidth }}
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 30, opacity: 0, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
          >
            {title && (
              <div className="flex items-center justify-between px-5 pb-3 pt-5">
                <h2 className="text-sm font-semibold text-white/90">{title}</h2>
                <button
                  onClick={onClose}
                  className="rounded-full p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white"
                  aria-label="Close"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
            )}
            <div className="px-5 pb-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
