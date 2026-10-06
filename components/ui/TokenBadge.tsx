import type { TokenConfig } from "@/lib/config/tokens";

/** Small, config-driven token glyph. No per-token art required. */
export function TokenBadge({
  token,
  size = 36,
  dim = false,
}: {
  token: TokenConfig;
  size?: number;
  dim?: boolean;
}) {
  const letter = token.symbol.replace(/^W/, "").slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden
      className="relative inline-flex shrink-0 items-center justify-center rounded-full font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        color: "#fff",
        background: `radial-gradient(120% 120% at 30% 20%, ${token.tint}, ${shade(token.tint, -34)})`,
        boxShadow: `0 1px 0 0 rgba(255,255,255,0.28) inset, 0 6px 16px -8px ${token.tint}`,
        opacity: dim ? 0.55 : 1,
      }}
    >
      {letter}
    </span>
  );
}

function shade(hex: string, amt: number): string {
  const h = hex.replace("#", "");
  const num = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  let r = (num >> 16) + amt;
  let g = ((num >> 8) & 0xff) + amt;
  let b = (num & 0xff) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
