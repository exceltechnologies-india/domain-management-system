'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Cookie, X } from 'lucide-react';
import { safeLocalStorage } from '@/lib/storage';
import { useSession } from 'next-auth/react';
import { publicPageHref } from '@/lib/reseller-os';

const CONSENT_KEY = 'cookieConsent';

export default function CookieConsentBanner() {
  const [visible, setVisible] = useState(false);
  // useSession can return undefined when this component renders outside a
  // SessionProvider context (rare race during hydration, observed in logs).
  // Defensive destructure avoids throwing into the global error boundary.
  const sessionResult = useSession();
  const session = sessionResult?.data;

  useEffect(() => {
    // Auto-accept for authenticated users — they've already agreed to cookies by using the service
    if (session?.user) {
      safeLocalStorage.setItem(CONSENT_KEY, 'accepted');
      setVisible(false);
      return;
    }
    if (!safeLocalStorage.getItem(CONSENT_KEY)) {
      setVisible(true);
    }
  }, [session]);

  const accept = () => {
    safeLocalStorage.setItem(CONSENT_KEY, 'accepted');
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie consent"
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-hairline bg-paper shadow-xl"
    >
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Cookie className="mt-0.5 h-5 w-5 shrink-0 text-indigo-ink" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-ink">We use essential cookies</p>
              <p className="mt-0.5 text-sm text-ink-2">
                This site uses strictly necessary cookies for authentication and security (session
                tokens, CSRF protection, reCAPTCHA). These are required for the service to function
                and cannot be disabled.{' '}
                <Link href={publicPageHref('/privacy')} className="font-medium text-indigo-ink underline hover:text-indigo-ink">
                  Privacy Policy
                </Link>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 sm:ml-4">
            <button
              onClick={accept}
              className="min-h-[44px] rounded-lg bg-primary-600 px-5 py-2 text-sm font-medium text-paper hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
            >
              Accept &amp; Continue
            </button>
            <button
              onClick={accept}
              aria-label="Dismiss cookie notice"
              className="min-h-[44px] min-w-[44px] grid place-items-center rounded-lg p-1.5 text-ink-4 hover:bg-hairline/50 hover:text-ink-2 focus:outline-none focus:ring-2 focus:ring-hairline-strong"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
