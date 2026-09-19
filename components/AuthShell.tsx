import { ReactNode } from 'react';
import Logo from './Logo';

interface AuthShellProps {
  /** Page heading above the card. */
  title: string;
  /** Secondary line under the heading. */
  subtitle?: ReactNode;
  /** The form contents. */
  children: ReactNode;
  /**
   * Kept so `LoginForm` and `MultiStageRegisterForm` keep compiling unchanged.
   * The brand panel these described is gone — see the note below — so both are
   * now ignored. Left in the signature rather than removed so this stays a
   * restyle of one file instead of a refactor of three.
   */
  panelEyebrow?: string;
  panelTitle?: string;
  /** Optional className passthrough on the outer wrapper. */
  className?: string;
}

/**
 * Shared shell for /login and /register.
 *
 * ─── WHY THE SPLIT-SCREEN WENT ───────────────────────────────────────────────
 * This was a two-column page: a purple gradient brand panel on the left with
 * blurred blobs, a grid overlay, a faux uptime stat card and a feature list,
 * with the form on the right. It looked nothing like the billing app a customer
 * of the same company signs into, which is the whole problem — two products,
 * one company, two unrelated first impressions.
 *
 * It now wears the billing app's auth chrome: warm paper background, brand mark
 * small and top-left, one centred card at max-w-md, a serif heading, a quiet
 * footer. Same tokens (`paper`, `ink`, `hairline`), same measurements, so the
 * two sign-ins read as one product.
 *
 * ─── WHAT DID NOT CHANGE ─────────────────────────────────────────────────────
 * Anything to do with behaviour. Both callers pass `title`, `subtitle` and
 * children exactly as before; every field, error state, reCAPTCHA, TOTP
 * step-up and social button lives in those callers and is untouched. This file
 * has never held logic and still does not.
 */
export default function AuthShell({
  title,
  subtitle,
  children,
  className = '',
}: AuthShellProps) {
  return (
    <div className={`min-h-screen bg-paper-2/50 flex flex-col ${className}`}>
      {/* Logo self-wraps in <Link href="/">; do NOT add an outer <Link> — nested
          <a> tags are invalid HTML, and the browser's parse-time correction
          produces a different DOM than the SSR'd one, which threw React #418 on
          every login/register load. That hazard survived the restyle. */}
      <header className="flex items-center justify-between p-6">
        <Logo size="md" />
      </header>

      <main className="flex-1 flex items-center justify-center px-4 pb-12">
        <div className="w-full max-w-md">
          <div className="bg-paper border border-hairline rounded-lg shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-6 sm:p-8">
            <div className="text-center mb-6">
              <h1 className="font-serif text-3xl mb-2 text-ink">{title}</h1>
              {subtitle && <p className="text-sm text-ink-3">{subtitle}</p>}
            </div>
            {children}
          </div>
        </div>
      </main>

      <footer className="p-6 text-center text-xs text-ink-3">
        © {new Date().getFullYear()} Anutech Digital Private Limited
      </footer>
    </div>
  );
}
