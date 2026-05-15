/**
 * postMessage protocol between the main app pages and the isolated
 * /razorpay-checkout iframe. The iframe is the only origin in the app
 * that loads checkout.razorpay.com/v1/checkout.js (which uses eval).
 * Keeping that load behind an iframe boundary lets the parent pages run
 * with a strict CSP (nonce-only script-src).
 *
 * Both directions:
 *   parent → iframe : {type: "open", options}
 *   iframe → parent : {type: "ready" | "success" | "dismiss" | "error"}
 *
 * Same-origin (no cross-domain). Both sides still verify `event.origin`
 * to defend against accidental message bleed from extensions / other
 * iframes loaded on the page.
 */

export interface RazorpayCheckoutOptions {
  key: string;
  amount?: number;
  currency?: string;
  name?: string;
  description?: string;
  order_id?: string;
  subscription_id?: string;
  prefill?: { email?: string; name?: string; contact?: string };
  theme?: { color?: string };
  // Razorpay accepts more options — kept open-ended deliberately.
  [k: string]: unknown;
}

export interface RazorpaySuccessPayload {
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

// Parent → iframe
export type ParentToFrame =
  | { type: "open"; options: RazorpayCheckoutOptions };

// Iframe → parent
export type FrameToParent =
  | { type: "ready" }
  | { type: "success"; payload: RazorpaySuccessPayload }
  | { type: "dismiss" }
  | { type: "error"; message: string };

export const RAZORPAY_FRAME_PATH = "/razorpay-checkout";
