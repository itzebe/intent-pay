"use client";

import { useEffect, useState } from "react";

/**
 * A QR code for a payment link, rendered as a data-URL image.
 *
 * `qrcode` is imported dynamically so it is never in the initial bundle, and the
 * data URL is permitted by the CSP's `img-src 'self' data:`. A failure to render
 * degrades to nothing (the link text is always shown alongside), never a crash.
 */
export function PaymentQR({ value, size = 180 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const QR = await import("qrcode");
        const url = await QR.toDataURL(value, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: size,
          color: { dark: "#0b0c0f", light: "#ffffff" },
        });
        if (!cancelled) setSrc(url);
      } catch {
        if (!cancelled) setSrc(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!src) return null;
  return (
    <span className="inline-block rounded-xl bg-white p-2" style={{ width: size + 16, height: size + 16 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="Payment link QR code" width={size} height={size} />
    </span>
  );
}
