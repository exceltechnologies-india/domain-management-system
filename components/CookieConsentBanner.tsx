'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Cookie, X } from 'lucide-react';
import { safeLocalStorage } from '@/lib/storage';
import { useSession } from 'next-auth/react';

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
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-200 bg-white shadow-xl"
    >
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Cookie className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-gray-900">We use essential cookies</p>
              <p className="mt-0.5 text-sm text-gray-600">
                This site uses strictly necessary cookies for authentication and security (session
                tokens, CSRF protection, reCAPTCHA). These are required for the service to function
                and cannot be disabled.{' '}
                <Link href="/privacy" className="font-medium text-blue-600 underline hover:text-blue-700">
                  Privacy Policy
                </Link>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 sm:ml-4">
            <button
              onClick={accept}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Accept &amp; Continue
            </button>
            <button
              onClick={accept}
              aria-label="Dismiss cookie notice"
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-300"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
