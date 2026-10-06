import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#08090B",
          900: "#0A0B0E",
          850: "#0E1013",
          800: "#131519",
          750: "#171A1F",
          700: "#1D2126",
          600: "#262B31",
        },
        mono: {
          DEFAULT: "#836EF9",
          soft: "#A78BFA",
          deep: "#5B4BD6",
        },
        accent: {
          cyan: "#5EEAD4",
          blue: "#60A5FA",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
        "4xl": "2rem",
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(131,110,249,0.25), 0 8px 40px -12px rgba(131,110,249,0.45)",
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 20px 60px -30px rgba(0,0,0,0.9)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        floaty: {
          "0%,100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-4px)" },
        },
        pulseRing: {
          "0%": { transform: "scale(0.9)", opacity: "0.7" },
          "100%": { transform: "scale(1.6)", opacity: "0" },
        },
      },
      animation: {
        shimmer: "shimmer 2.2s linear infinite",
        floaty: "floaty 4s ease-in-out infinite",
        pulseRing: "pulseRing 1.6s ease-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
