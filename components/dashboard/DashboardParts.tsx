/**
 * The Customer Portal dashboard's building blocks, in the ResellerOS dashboard pattern
 * (Pawan, 10 Oct 2026: "Re-use this design pattern for our DMS panel"): an uppercase section
 * label, number tiles, tinted "attention" cards with a footer action, and titled panels.
 * Colours are DMS's own tokens — its `amber` is the brand blue.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{children}</h2>
      {action}
    </div>
  );
}

export function Tile({ label, value, note, href }: { label: string; value: ReactNode; note?: ReactNode; href?: string }) {
  const body = (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</p>
      <p className="mt-2 font-serif text-3xl font-semibold text-ink tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs text-ink-3">{note}</p>}
    </>
  );
  const cls = 'block rounded-xl border border-hairline bg-paper p-4 shadow-sm';
  return href ? (
    <Link href={href} className={`${cls} transition-colors hover:border-amber/40 hover:bg-amber-soft/30`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const TONES = {
  rose: { card: 'border-rose/30 bg-gradient-to-br from-rose-soft via-rose-soft/40 to-paper', pill: 'bg-rose-soft text-rose-ink border-rose/30', dot: 'bg-rose', icon: 'bg-rose/10 text-rose-ink', rule: 'border-rose/20' },
  indigo: { card: 'border-indigo/25 bg-gradient-to-br from-indigo-soft via-indigo-soft/40 to-paper', pill: 'bg-indigo-soft text-indigo-ink border-indigo/25', dot: 'bg-indigo', icon: 'bg-indigo/10 text-indigo-ink', rule: 'border-indigo/20' },
  emerald: { card: 'border-emerald/25 bg-gradient-to-br from-emerald-soft via-emerald-soft/40 to-paper', pill: 'bg-emerald-soft text-emerald-ink border-emerald/25', dot: 'bg-emerald', icon: 'bg-emerald/10 text-emerald-ink', rule: 'border-emerald/20' },
  blue: { card: 'border-amber/25 bg-gradient-to-br from-amber-soft via-amber-soft/40 to-paper', pill: 'bg-amber-soft text-amber-ink border-amber/25', dot: 'bg-amber', icon: 'bg-amber/10 text-amber-ink', rule: 'border-amber/20' },
} as const;
export type Tone = keyof typeof TONES;

export function AttentionCard({
  tone, tag, title, text, icon, footer, action,
}: {
  tone: Tone; tag: string; title: string; text: string; icon: ReactNode; footer: string;
  action?: { label: string; href: string };
}) {
  const t = TONES[tone];
  return (
    <div className={`flex flex-col rounded-xl border p-4 shadow-sm ${t.card}`}>
      <div className="flex flex-1 items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${t.pill}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden />
            {tag}
          </span>
          <h3 className="mt-2 text-sm font-semibold text-ink">{title}</h3>
          <p className="mt-0.5 text-xs text-ink-2">{text}</p>
        </div>
        <span className={`grid h-10 w-10 flex-none place-items-center rounded-full ${t.icon}`} aria-hidden>{icon}</span>
      </div>
      <div className={`mt-4 flex items-center justify-between gap-3 border-t pt-3 ${t.rule}`}>
        <span className="truncate text-xs text-ink-3">{footer}</span>
        {action && (
          <Link
            href={action.href}
            className="inline-flex min-h-[32px] flex-none items-center gap-1 rounded-md border border-hairline bg-paper px-2.5 text-xs font-medium text-ink-2 hover:bg-paper-2"
          >
            {action.label}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </div>
  );
}

export function Panel({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-hairline bg-paper shadow-sm">
      <header className="flex items-start justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="text-xs text-ink-3">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex min-h-[32px] flex-none items-center gap-1 text-xs font-medium text-amber-ink hover:underline">
      {children}
      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-ink-3">{children}</p>;
}
