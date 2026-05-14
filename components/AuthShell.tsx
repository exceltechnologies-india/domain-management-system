'use client';

import { ReactNode } from 'react';
import Link from 'next/link';
import { CheckCircle, Globe, Shield, Headphones, Sparkles, TrendingUp } from 'lucide-react';
import Logo from './Logo';

interface AuthShellProps {
  /** Page heading on the form side. */
  title: string;
  /** Secondary line under the heading. */
  subtitle?: ReactNode;
  /** The form contents. */
  children: ReactNode;
  /** Eyebrow chip text on the brand panel (e.g. "Sign in", "Get started"). */
  panelEyebrow?: string;
  /** Headline on the brand panel. */
  panelTitle?: string;
  /** Optional className passthrough on outer wrapper. */
  className?: string;
}

const DEFAULT_HIGHLIGHTS = [
  { icon: Globe, text: 'Domains across 100+ TLDs with transparent pricing' },
  { icon: Shield, text: 'Google-grade hosting with free SSL and daily backups' },
  { icon: Headphones, text: '24/7 support from real people, not scripts' },
];

/**
 * Shared shell for /login and /register. Two-column on desktop:
 *  - Left:  brand panel with gradient + feature highlights
 *  - Right: scrollable form area with logo, title, subtitle, and children
 * On mobile the brand panel hides; only the form remains.
 */
export default function AuthShell({
  title,
  subtitle,
  children,
  panelEyebrow = 'Anutech Digital',
  panelTitle = 'The clean way to own your online identity',
  className = '',
}: AuthShellProps) {
  return (
    <div className={`min-h-screen bg-gray-50 ${className}`}>
      <div className="grid lg:grid-cols-[1.05fr_1fr] xl:grid-cols-[1.15fr_1fr] min-h-screen">
        {/* Brand panel — hidden on mobile */}
        <aside className="hidden lg:flex relative overflow-hidden flex-col justify-between p-10 xl:p-14 text-white bg-gradient-to-br from-blue-700 via-blue-600 to-indigo-800">
          {/* Decorative blobs */}
          <div className="absolute -top-32 -right-24 w-[28rem] h-[28rem] rounded-full bg-blue-400/25 blur-3xl pointer-events-none" />
          <div className="absolute -bottom-32 -left-24 w-[32rem] h-[32rem] rounded-full bg-indigo-500/30 blur-3xl pointer-events-none" />
          <div className="absolute top-1/3 right-1/4 w-72 h-72 rounded-full bg-violet-500/15 blur-3xl pointer-events-none" />
          <div
            className="absolute inset-0 opacity-[0.06] pointer-events-none"
            style={{
              backgroundImage:
                'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
              backgroundSize: '48px 48px',
            }}
          />

          {/* Top: logo */}
          <div className="relative z-10 flex items-center justify-between">
            <Link href="/" className="inline-block">
              <Logo size="lg" variant="dark" />
            </Link>
          </div>

          {/* Middle: headline + preview card */}
          <div className="relative z-10 my-auto py-8">
            <div className="inline-flex items-center gap-2 bg-white/15 backdrop-blur-md border border-white/25 rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {panelEyebrow}
            </div>
            <h2 className="mt-5 text-3xl xl:text-4xl font-bold leading-tight tracking-tight" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
              {panelTitle}
            </h2>
            <p className="mt-3 text-white/80 text-base leading-relaxed max-w-md">
              Domains, hosting, and DNS — managed from one clean dashboard, secured by Google-grade infrastructure.
            </p>

            {/* Faux stat card for visual interest */}
            <div className="mt-8 max-w-sm bg-white/[0.07] backdrop-blur-md border border-white/15 rounded-2xl p-4 shadow-xl">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-emerald-400/15 border border-emerald-300/25 shrink-0">
                  <TrendingUp className="h-5 w-5 text-emerald-300" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wider text-white/60 font-semibold">Uptime · last 30 days</p>
                  <p className="text-2xl font-bold tabular-nums">99.98<span className="text-base text-white/60">%</span></p>
                </div>
                <div className="ml-auto text-right">
                  <p className="text-[11px] uppercase tracking-wider text-white/60 font-semibold">Domains</p>
                  <p className="text-2xl font-bold tabular-nums">10k+</p>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom: highlights + trust line */}
          <div className="relative z-10">
            <ul className="space-y-3">
              {DEFAULT_HIGHLIGHTS.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.text} className="flex items-start gap-3">
                    <span className="mt-0.5 flex items-center justify-center h-7 w-7 rounded-lg bg-white/15 backdrop-blur-md border border-white/25 shrink-0">
                      <Icon className="h-3.5 w-3.5 text-white" />
                    </span>
                    <span className="text-sm text-white/90 leading-snug pt-1">{item.text}</span>
                  </li>
                );
              })}
            </ul>

            <div className="mt-8 pt-6 border-t border-white/10 flex items-center justify-between text-xs text-white/70">
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle className="h-3.5 w-3.5 text-emerald-300" />
                Trusted by 5,000+ customers across India
              </span>
              <span className="inline-flex items-center gap-1.5 text-white/60">
                <Sparkles className="h-3 w-3" />
                ISO-aligned security
              </span>
            </div>
          </div>
        </aside>

        {/* Form panel */}
        <main className="flex flex-col">
          {/* Mobile-only top bar with logo */}
          <div className="lg:hidden flex items-center justify-center pt-8 pb-2">
            <Link href="/">
              <Logo size="md" />
            </Link>
          </div>

          <div className="flex-1 flex items-center justify-center px-4 sm:px-8 py-10 sm:py-14">
            <div className="w-full max-w-md">
              <div className="text-center lg:text-left mb-6 sm:mb-8">
                <h1 className="text-2xl sm:text-3xl font-bold text-gray-900" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                  {title}
                </h1>
                {subtitle && (
                  <p className="mt-2 text-sm text-gray-500">{subtitle}</p>
                )}
              </div>
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5 sm:p-7">
                {children}
              </div>
            </div>
          </div>

          <footer className="px-6 pb-6 pt-2 text-center text-xs text-gray-400">
            © {new Date().getFullYear()} Anutech Digital Private Limited
          </footer>
        </main>
      </div>
    </div>
  );
}
