import { useState } from "react";
import type { TokenConfig } from "@/lib/config/tokens";

const FALLBACK_TINT = "#8A92B2";

/** Small, config-driven token glyph. Uses the list's logo when present, else a
 * deterministic letter badge — no per-token art is required.
 *
 * Defensive by design: a token that arrives from an external source (a wallet
 * indexer, a pasted address, a remote list) may be missing `tint` or `symbol`.
 * A missing glyph colour must degrade to an accent — never throw, because a
 * throw here unmounts the whole app (the USDC→MON blank screen). */
export function TokenBadge({
  token,
  size = 36,
  dim = false,
}: {
  token: TokenConfig;
  size?: number;
  dim?: boolean;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const symbol = typeof token?.symbol === "string" ? token.symbol : "";
  const letter = symbol.replace(/^W/, "").slice(0, 1).toUpperCase() || "?";
  const tint =
    typeof token?.tint === "string" && token.tint ? token.tint : FALLBACK_TINT;
  const showLogo = Boolean(token.logoURI) && !logoFailed;

  return (
    <span
      aria-hidden
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        color: "#fff",
        background: `radial-gradient(120% 120% at 30% 20%, ${tint}, ${shade(tint, -34)})`,
        boxShadow: `0 1px 0 0 rgba(255,255,255,0.28) inset, 0 6px 16px -8px ${tint}`,
        opacity: dim ? 0.55 : 1,
      }}
    >
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={token.logoURI}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setLogoFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        letter
      )}
    </span>
  );
}

function shade(hex: string, amt: number): string {
  const h = String(hex ?? "").replace("#", "");
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(h)) return FALLBACK_TINT;
  const num = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  let r = (num >> 16) + amt;
  let g = ((num >> 8) & 0xff) + amt;
  let b = (num & 0xff) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
