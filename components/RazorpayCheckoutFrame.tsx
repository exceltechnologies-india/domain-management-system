'use client';

/**
 * Iframe-based Razorpay checkout host.
 *
 * Parent pages use the `useRazorpayCheckout` hook below; calling `open(options)`
 * mounts a full-viewport overlay containing the isolated /razorpay-checkout
 * iframe. The hook returns a Promise that resolves with the Razorpay success
 * payload, or rejects with a typed reason on dismiss/error.
 *
 * Why an iframe? checkout.razorpay.com/v1/checkout.js uses `eval` and
 * `new Function`, which requires `'unsafe-eval'` in CSP. Hosting it inside
 * its own route lets the rest of the app keep a strict, nonce-only script-src.
 * See lib/razorpay-checkout-protocol.ts for the postMessage contract.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type {
  FrameToParent,
  RazorpayCheckoutOptions,
  RazorpaySuccessPayload,
} from '@/lib/razorpay-checkout-protocol';
import { RAZORPAY_FRAME_PATH } from '@/lib/razorpay-checkout-protocol';

export type RazorpayCheckoutError =
  | { kind: 'dismissed' }
  | { kind: 'error'; message: string };

interface PendingResolver {
  resolve: (payload: RazorpaySuccessPayload) => void;
  reject: (err: RazorpayCheckoutError) => void;
  options: RazorpayCheckoutOptions;
}

export interface UseRazorpayCheckout {
  open: (options: RazorpayCheckoutOptions) => Promise<RazorpaySuccessPayload>;
  /** React component that must be rendered somewhere inside the consumer tree. */
  Frame: () => ReactElement | null;
}

export function useRazorpayCheckout(): UseRazorpayCheckout {
  const [active, setActive] = useState<PendingResolver | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameReadyRef = useRef(false);
  const activeRef = useRef<PendingResolver | null>(null);
  activeRef.current = active;

  // Settle the active checkout exactly once.
  const settleSuccess = useCallback((payload: RazorpaySuccessPayload) => {
    const pending = activeRef.current;
    if (!pending) return;
    activeRef.current = null;
    frameReadyRef.current = false;
    setActive(null);
    pending.resolve(payload);
  }, []);

  const settleError = useCallback((err: RazorpayCheckoutError) => {
    const pending = activeRef.current;
    if (!pending) return;
    activeRef.current = null;
    frameReadyRef.current = false;
    setActive(null);
    pending.reject(err);
  }, []);

  // Listen for messages from the iframe.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const msg = event.data as FrameToParent;
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

      switch (msg.type) {
        case 'ready': {
          frameReadyRef.current = true;
          const pending = activeRef.current;
          if (pending && iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              { type: 'open', options: pending.options },
              window.location.origin
            );
          }
          break;
        }
        case 'success':
          settleSuccess(msg.payload);
          break;
        case 'dismiss':
          settleError({ kind: 'dismissed' });
          break;
        case 'error':
          settleError({ kind: 'error', message: msg.message });
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [settleError, settleSuccess]);

  const open = useCallback(
    (options: RazorpayCheckoutOptions): Promise<RazorpaySuccessPayload> => {
      return new Promise<RazorpaySuccessPayload>((resolve, reject) => {
        if (activeRef.current) {
          reject({ kind: 'error', message: 'Razorpay checkout already in progress' });
          return;
        }
        const entry: PendingResolver = { resolve, reject, options };
        activeRef.current = entry;
        frameReadyRef.current = false;
        setActive(entry);
        // If the iframe was already mounted from a previous checkout it will
        // re-send "ready" on remount because we toggle `active` (the Frame is
        // unmounted between checkouts) — the message listener above forwards
        // the "open" message once ready.
      });
    },
    []
  );

  const Frame = useCallback(() => {
    if (!active) return null;
    return (
      <div
        className="fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center"
        aria-hidden={!active}
      >
        <iframe
          ref={iframeRef}
          src={RAZORPAY_FRAME_PATH}
          title="Razorpay checkout"
          className="w-full h-full border-0"
          // sandbox without `allow-same-origin` would block our same-origin
          // postMessage handshake — explicit allowlist instead.
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-top-navigation-by-user-activation"
        />
      </div>
    );
  }, [active]);

  return { open, Frame };
}
