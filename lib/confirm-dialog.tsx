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
    btn: 'bg-primary-600 hover:bg-primary-700 text-paper focus:ring-primary-500',
    ring: 'focus:ring-primary-500',
    iconBg: 'bg-indigo-soft',
    iconColor: 'text-indigo-ink',
  },
  danger: {
    btn: 'bg-rose hover:bg-rose/90 text-paper focus:ring-rose',
    ring: 'focus:ring-rose',
    iconBg: 'bg-rose-soft',
    iconColor: 'text-rose-ink',
  },
  warning: {
    btn: 'bg-amber hover:bg-amber/90 text-paper focus:ring-amber',
    ring: 'focus:ring-amber',
    iconBg: 'bg-amber-soft',
    iconColor: 'text-amber-ink',
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
        className="absolute inset-0 bg-ink/50 backdrop-blur-sm"
        onClick={() => handleClose(false)}
      />

      {/* Card */}
      <div
        className={`relative bg-paper rounded-2xl shadow-2xl border border-hairline w-full max-w-md overflow-hidden transition-transform duration-150 ${
          isClosing ? 'scale-95' : 'scale-100'
        }`}
      >
        <button
          type="button"
          onClick={() => handleClose(false)}
          className="absolute top-3 right-3 p-1.5 text-ink-4 hover:text-ink-2 hover:bg-hairline/50 rounded-lg transition-colors"
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
                <h3 className="text-base font-semibold text-ink mb-1.5">
                  {request.title}
                </h3>
              )}
              <p className="text-sm text-ink-2 leading-relaxed whitespace-pre-line">
                {request.message}
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 sm:px-6 py-3.5 bg-paper-2 border-t border-hairline flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => handleClose(false)}
            className="px-4 py-2 text-sm font-medium text-ink-2 bg-paper border border-hairline rounded-lg hover:bg-paper-2 hover:border-hairline transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-hairline-strong"
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
