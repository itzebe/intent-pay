import Link from "next/link";

/**
 * Site-wide footer. Server component: static, no client state.
 *
 * Rendered at the bottom of the main payment homepage (and reused by the docs
 * shell) so contact and documentation links are reachable from the app itself,
 * not only from the documentation pages. Links are limited to real destinations
 * — the official X account, the support mailbox, and the docs routes — with no
 * fabricated company or social information.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-white/[0.06] bg-ink-950/40">
      <div className="mx-auto max-w-5xl px-5 py-10">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-mono to-mono-deep text-sm font-black text-white shadow-glow">
                ⌁
              </span>
              <span className="text-sm font-semibold tracking-tight text-white">Intent Pay</span>
            </div>
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-white/45">
              Intent-based payments on Monad.
            </p>
          </div>

          <FooterColumn title="Social">
            <FooterLink href="https://x.com/IntentPayApp" external label="X (Twitter)">
              <XIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span>@IntentPayApp</span>
            </FooterLink>
          </FooterColumn>

          <FooterColumn title="Support">
            <FooterLink href="mailto:jonathanebi05@gmail.com" label="Support">
              <MailIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span>jonathanebi05@gmail.com</span>
            </FooterLink>
          </FooterColumn>

          <FooterColumn title="Documentation">
            <FooterLink href="/docs/litepaper" label="Litepaper">
              Litepaper
            </FooterLink>
            <FooterLink href="/docs/faq" label="FAQ">
              FAQ
            </FooterLink>
          </FooterColumn>
        </div>

        <div className="mt-8 flex flex-col gap-3 border-t border-white/[0.06] pt-5 text-xs text-white/35 sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} Intent Pay</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" aria-hidden="true" />
            Monad Mainnet · chain id 143
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/35">
        {title}
      </div>
      <ul className="mt-3 space-y-2.5">{children}</ul>
    </div>
  );
}

function FooterLink({
  href,
  label,
  external,
  children,
}: {
  href: string;
  label: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        aria-label={label}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="inline-flex items-center gap-2 text-xs text-white/55 transition hover:text-white"
      >
        {children}
      </Link>
    </li>
  );
}

function XIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="fill-current" {...props}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function MailIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="fill-none stroke-current"
      strokeWidth="1.7"
      {...props}
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 6.5 8.5 6 8.5-6" />
    </svg>
  );
}
