'use client';

/**
 * Isolated Razorpay checkout iframe page.
 *
 * This is the ONLY route in the app that loads checkout.razorpay.com/v1/checkout.js,
 * which uses `eval` / `new Function` and therefore requires `unsafe-eval` in CSP.
 * Every Razorpay payment flow in the app embeds this page in an iframe and
 * communicates via postMessage. That keeps the rest of the app on a strict CSP.
 *
 * Protocol: see lib/razorpay-checkout-protocol.ts. Both directions verify
 * event.origin === window.location.origin (same-origin guarantee).
 */

import { useEffect, useRef, useState } from 'react';
import type {
  ParentToFrame,
  FrameToParent,
  RazorpayCheckoutOptions,
} from '@/lib/razorpay-checkout-protocol';

interface RazorpayPaymentResponse {
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
  razorpay_payment_id: string;
  razorpay_signature?: string;
}
interface RazorpayInstance {
  open: () => void;
}
interface RazorpayConstructor {
  new (options: RazorpayCheckoutOptions & {
    handler: (response: RazorpayPaymentResponse) => void;
    modal?: { ondismiss?: () => void; [k: string]: unknown };
  }): RazorpayInstance;
}
declare global {
  interface Window {
    Razorpay: RazorpayConstructor;
  }
}

function send(message: FrameToParent) {
  // Same-origin parent. Restrict targetOrigin to our own origin.
  try {
    window.parent.postMessage(message, window.location.origin);
  } catch {
    /* parent gone — nothing to do */
  }
}

export default function RazorpayCheckoutFramePage() {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'opening' | 'done'>('loading');
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(false);

  // Load checkout.js exactly once on mount.
  useEffect(() => {
    if (window.Razorpay) {
      setPhase('ready');
      send({ type: 'ready' });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => {
      setPhase('ready');
      send({ type: 'ready' });
    };
    script.onerror = () => {
      setError('Failed to load Razorpay checkout');
      send({ type: 'error', message: 'Failed to load Razorpay checkout' });
    };
    document.body.appendChild(script);
    return () => {
      // Don't remove the script — Razorpay attaches global state to it.
    };
  }, []);

  // Listen for the parent's "open" message and instantiate Razorpay.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const msg = event.data as ParentToFrame;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'open') {
        if (opened.current) return; // ignore duplicate opens
        opened.current = true;
        openRazorpay(msg.options);
      }
    }

    function openRazorpay(options: RazorpayCheckoutOptions) {
      if (!window.Razorpay) {
        send({ type: 'error', message: 'Razorpay SDK not loaded yet' });
        return;
      }
      setPhase('opening');

      const wired = {
        ...options,
        handler: (response: RazorpayPaymentResponse) => {
          // Razorpay calls this when payment succeeds.
          send({
            type: 'success',
            payload: {
              razorpay_order_id: response.razorpay_order_id,
              razorpay_subscription_id: response.razorpay_subscription_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature ?? '',
            },
          });
          setPhase('done');
        },
        modal: {
          ...((options.modal as object | undefined) ?? {}),
          ondismiss: () => {
            send({ type: 'dismiss' });
            setPhase('done');
          },
        },
      };

      try {
        const rzp = new window.Razorpay(wired);
        rzp.open();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Razorpay open failed';
        send({ type: 'error', message });
        setPhase('done');
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // The visible body is intentionally minimal: Razorpay's own modal will cover
  // the iframe once `rzp.open()` is called. We just show a tiny spinner /
  // status string for the brief loading + ready window.
  return (
    <div className="min-h-screen flex items-center justify-center bg-transparent">
      <div className="text-sm text-gray-500">
        {error ? (
          <span className="text-red-600">{error}</span>
        ) : phase === 'loading' ? (
          'Loading payment options…'
        ) : phase === 'ready' ? (
          'Ready'
        ) : phase === 'opening' ? (
          'Opening payment form…'
        ) : (
          ''
        )}
      </div>
    </div>
  );
}
