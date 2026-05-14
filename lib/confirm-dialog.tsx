'use client';

/**
 * Imperative `confirmDialog()` helper that renders a styled modal anywhere
 * in the app — Promise-based replacement for `window.confirm()`.
 *
 * Usage:
 *   const ok = await confirmDialog({
 *     title: 'Delete this domain?',
 *     message: 'This action cannot be undone.',
 *     confirmText: 'Delete',
 *     tone: 'danger',
 *   });
 *
 * The host (<ConfirmDialogHost />) is mounted once in the root layout and
 * subscribes to a tiny pub/sub. No context provider needed.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, X, Loader2 } from 'lucide-react';

export type ConfirmTone = 'primary' | 'danger' | 'warning';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmTone;
}

interface OpenRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

type Listener = (req: OpenRequest | null) => void;

const listeners = new Set<Listener>();
let pending: OpenRequest | null = null;

function emit(req: OpenRequest | null) {
  pending = req;
  listeners.forEach((l) => l(req));
}

/**
 * Open a confirmation dialog. Resolves true if the user confirms, false if
 * they cancel or dismiss. Falls back to `window.confirm` only if the host
 * is not mounted (SSR or pre-hydration).
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (listeners.size === 0) {
    // Host not mounted — fall back to the native dialog so the calling code
    // still works (e.g. in tests or during the first paint of a new page).
    const text = opts.title ? `${opts.title}\n\n${opts.message}` : opts.message;
    return Promise.resolve(window.confirm(text));
  }
  return new Promise<boolean>((resolve) => {
    emit({
      tone: 'primary',
      confirmText: 'Confirm',
      cancelText: 'Cancel',
      ...opts,
      resolve,
    });
  });
}

const TONE_STYLES: Record<ConfirmTone, { btn: string; ring: string; iconBg: string; iconColor: string }> = {
  primary: {
    btn: 'bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-500',
    ring: 'focus:ring-blue-500',
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-600',
  },
  danger: {
    btn: 'bg-red-600 hover:bg-red-700 text-white focus:ring-red-500',
    ring: 'focus:ring-red-500',
    iconBg: 'bg-red-50',
    iconColor: 'text-red-600',
  },
  warning: {
    btn: 'bg-amber-600 hover:bg-amber-700 text-white focus:ring-amber-500',
    ring: 'focus:ring-amber-500',
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-600',
  },
};

export function ConfirmDialogHost() {
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    const listener: Listener = (req) => {
      setIsClosing(false);
      setRequest(req);
    };
    listeners.add(listener);
    // Catch any request that fired before mount (race during initial render)
    if (pending) listener(pending);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose(false);
      if (e.key === 'Enter') handleClose(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const handleClose = (ok: boolean) => {
    if (!request) return;
    setIsClosing(true);
    request.resolve(ok);
    // Brief delay lets the fade-out animation play.
    window.setTimeout(() => {
      setRequest(null);
      setIsClosing(false);
      // Clear the queued request so a future mount doesn't replay it.
      if (pending === request) pending = null;
    }, 120);
  };

  if (!request) return null;

  const tone = TONE_STYLES[request.tone || 'primary'];

  return (
    <div
      aria-modal="true"
      role="dialog"
      className={`fixed inset-0 z-[2000] flex items-center justify-center p-4 transition-opacity duration-150 ${
        isClosing ? 'opacity-0' : 'opacity-100'
      }`}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-gray-900/50 backdrop-blur-sm"
        onClick={() => handleClose(false)}
      />

      {/* Card */}
      <div
        className={`relative bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-md overflow-hidden transition-transform duration-150 ${
          isClosing ? 'scale-95' : 'scale-100'
        }`}
      >
        <button
          type="button"
          onClick={() => handleClose(false)}
          className="absolute top-3 right-3 p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <div className={`p-2.5 rounded-xl shrink-0 ${tone.iconBg}`}>
              <AlertTriangle className={`h-5 w-5 ${tone.iconColor}`} />
            </div>
            <div className="flex-1 min-w-0 pt-0.5">
              {request.title && (
                <h3 className="text-base font-semibold text-gray-900 mb-1.5">
                  {request.title}
                </h3>
              )}
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                {request.message}
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 sm:px-6 py-3.5 bg-gray-50 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => handleClose(false)}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-400"
          >
            {request.cancelText || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => handleClose(true)}
            autoFocus
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${tone.btn}`}
          >
            {request.confirmText || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Re-exported as a no-op stub for SSR safety in places that import the host.
export const __ConfirmDialogInternal = { listeners };

// Small helper for "are you absolutely sure" deletes — common pattern.
export function confirmDanger(message: string, options: Partial<ConfirmOptions> = {}): Promise<boolean> {
  return confirmDialog({
    tone: 'danger',
    confirmText: 'Delete',
    ...options,
    message,
  });
}

// Spinner for callers that want to indicate the action is running after
// confirm. Not used by the host itself.
export { Loader2 as ConfirmSpinner };
