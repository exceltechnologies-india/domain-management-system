/**
 * Tests for `@/lib/razorpay-checkout-protocol` (rescan-4 slice 7df).
 * The postMessage protocol contract module — mostly types + a single
 * constant. Pins the constant + the shape contracts (compile-time
 * checks via `satisfies`).
 */
import { describe, it, expect } from "vitest";
import type {
  RazorpayCheckoutOptions,
  RazorpaySuccessPayload,
  ParentToFrame,
  FrameToParent,
} from "@/lib/razorpay-checkout-protocol";
import { RAZORPAY_FRAME_PATH } from "@/lib/razorpay-checkout-protocol";

describe("razorpay-checkout-protocol", () => {
  it("exports RAZORPAY_FRAME_PATH as '/razorpay-checkout'", () => {
    expect(RAZORPAY_FRAME_PATH).toBe("/razorpay-checkout");
  });

  it("RazorpayCheckoutOptions accepts the documented minimum shape", () => {
    const minimal: RazorpayCheckoutOptions = { key: "rzp_test_xyz" };
    expect(minimal.key).toBe("rzp_test_xyz");
  });

  it("RazorpayCheckoutOptions allows pass-through of unknown keys", () => {
    // The interface declares [k: string]: unknown so extra Razorpay-only
    // options pass through without a TS error.
    const withExtras: RazorpayCheckoutOptions = {
      key: "rzp_test_xyz",
      amount: 1000,
      currency: "INR",
      "callback_url": "https://example.com/callback",
      "razorpay_subscription_id_extra": "sub_123",
    };
    expect(withExtras["callback_url"]).toBe("https://example.com/callback");
  });

  it("RazorpayCheckoutOptions accepts the Tokens-flow recurring shape (Phase 2G)", () => {
    // Tokens flow opens Razorpay Checkout with order_id + customer_id +
    // recurring: '1' to invoke the autopay mandate UI. Pinning the type
    // surface so the existing app/checkout/page.tsx call site keeps
    // compiling cleanly.
    const tokensOpts: RazorpayCheckoutOptions = {
      key: "rzp_live_T5NRBOq7ByM414",
      name: "AnuTech Digital",
      description: "Hosting trial — ₹2 mandate setup (refunded immediately)",
      order_id: "order_TOK_AUTH",
      customer_id: "cust_T",
      recurring: "1",
      prefill: { email: "user@x.com", name: "Test User" },
      theme: { color: "#3b82f6" },
    };
    expect(tokensOpts.customer_id).toBe("cust_T");
    expect(tokensOpts.recurring).toBe("1");
    expect(tokensOpts.order_id).toBe("order_TOK_AUTH");
    // subscription_id is NOT used in Tokens mode — it should remain undefined
    expect(tokensOpts.subscription_id).toBeUndefined();
  });

  it("RazorpayCheckoutOptions also accepts recurring: 1 (numeric form)", () => {
    const opts: RazorpayCheckoutOptions = {
      key: "rzp_live_x",
      order_id: "order_x",
      customer_id: "cust_x",
      recurring: 1,
    };
    expect(opts.recurring).toBe(1);
  });

  it("RazorpaySuccessPayload requires payment_id + signature", () => {
    const payload: RazorpaySuccessPayload = {
      razorpay_payment_id: "pay_abc",
      razorpay_signature: "sig_xyz",
    };
    expect(payload.razorpay_payment_id).toBe("pay_abc");
    // Optional fields are absent — that's fine, no TS error.
    expect(payload.razorpay_order_id).toBeUndefined();
  });

  it("ParentToFrame is restricted to the 'open' message", () => {
    const open: ParentToFrame = { type: "open", options: { key: "rzp_test_xyz" } };
    expect(open.type).toBe("open");
  });

  it("FrameToParent covers ready / success / dismiss / error", () => {
    const ready: FrameToParent = { type: "ready" };
    const success: FrameToParent = {
      type: "success",
      payload: { razorpay_payment_id: "p", razorpay_signature: "s" },
    };
    const dismiss: FrameToParent = { type: "dismiss" };
    const error: FrameToParent = { type: "error", message: "boom" };
    expect([ready.type, success.type, dismiss.type, error.type]).toEqual([
      "ready",
      "success",
      "dismiss",
      "error",
    ]);
  });
});
