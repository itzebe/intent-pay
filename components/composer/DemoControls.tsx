"use client";

/**
 * Demo-only controls. These let a judge exercise edge cases (like the
 * overpayment guard) that exact-output routing would otherwise make
 * unreachable. They are never rendered in live mode.
 */
export function DemoControls({
  simulateMove,
  onChange,
}: {
  simulateMove: number;
  onChange: (fraction: number) => void;
}) {
  const options: { label: string; value: number }[] = [
    { label: "Normal", value: 0 },
    { label: "Price move +20%", value: 0.2 },
  ];

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-white/10 px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-white/55">Simulate price move</p>
        <p className="text-[10px] text-white/30">Demo only · shows the overpayment guard</p>
      </div>
      <div className="flex shrink-0 gap-1 rounded-lg bg-white/[0.05] p-0.5">
        {options.map((o) => (
          <button
            key={o.label}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
              simulateMove === o.value
                ? "bg-white/10 text-white"
                : "text-white/45 hover:text-white/80"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
