'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, LogIn, X } from 'lucide-react';
import { AUTH_EXPIRED_EVENT } from '@/lib/api-client';

/**
 * App-wide "session expired" prompt for admin surfaces.
 *
 * Listens for the `dms:auth-expired` event that apiClient dispatches on a
 * 401 response (see lib/api-client.ts). Mounted once in AdminLayout so
 * every admin page gets consistent handling — a background API call whose
 * auth has lapsed surfaces a clear, actionable banner instead of each page
 * rendering a raw "Unauthorized" string (or silently failing).
 *
 * Non-destructive: it overlays a top banner; the page keeps whatever data it
 * had already loaded. "Retry" reloads; "Sign in" routes to /login with a
 * returnUrl so the operator lands back where they were.
 */
export default function SessionExpiredBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onExpired = () => setVisible(true);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired as EventListener);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired as EventListener);
  }, []);

  if (!visible) return null;

  const signIn = () => {
    const returnUrl = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/admin/dashboard';
    window.location.href = `/login?returnUrl=${encodeURIComponent(returnUrl)}`;
  };

  return (
    <div className="fixed top-0 inset-x-0 z-[100] flex justify-center px-4 pt-3 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-2xl bg-amber-50 border border-amber-300 shadow-lg rounded-xl px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-900">Your session expired</p>
            <p className="text-xs text-amber-800/90">A recent action wasn&apos;t authorized. Sign in again to continue — any data on screen is still the last loaded copy.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-white border border-amber-300 text-amber-800 hover:bg-amber-100 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
          <button
            onClick={signIn}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 transition-colors"
          >
            <LogIn className="h-3.5 w-3.5" /> Sign in
          </button>
          <button
            onClick={() => setVisible(false)}
            aria-label="Dismiss"
            className="p-1.5 rounded-lg text-amber-700 hover:bg-amber-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
