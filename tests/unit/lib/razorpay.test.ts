import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";

// RazorpayService reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET at module load
// time and throws if either is missing. vi.hoisted() runs in the same hoist
// phase as vi.mock(), so env is set before the module is evaluated.
vi.hoisted(() => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_keyid";
  process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
});

// Mock the Razorpay SDK constructor so module evaluation does not attempt
// to instantiate a real API client. Must be a real constructable function —
// arrow-returning vi.fn() is rejected by vitest with "is not a constructor".
vi.mock("razorpay", () => {
  function MockRazorpay(this: any) {
    this.orders = { create: vi.fn(), fetch: vi.fn() };
    this.payments = { fetch: vi.fn(), refund: vi.fn() };
    this.subscriptions = { create: vi.fn(), fetch: vi.fn(), cancel: vi.fn() };
    this.plans = { create: vi.fn(), fetch: vi.fn() };
  }
  return { default: MockRazorpay };
});

// Suppress logger noise from intentionally-failed verifications.
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const PAY_SECRET = "rzp_test_secret";

import { RazorpayService } from "@/lib/razorpay";

function signOrderPayment(orderId: string, paymentId: string): string {
  return crypto
    .createHmac("sha256", PAY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

function signSubscriptionPayment(paymentId: string, subscriptionId: string): string {
  return crypto
    .createHmac("sha256", PAY_SECRET)
    .update(`${paymentId}|${subscriptionId}`)
    .digest("hex");
}

function signWebhook(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("RazorpayService.verifyPayment — order flow", () => {
  const ORDER_ID = "order_NaJlYqQNoyfXjk";
  const PAYMENT_ID = "pay_NaJmHfRpQ9wXLm";

  it("accepts a correctly-signed order payment", () => {
    const signature = signOrderPayment(ORDER_ID, PAYMENT_ID);
    expect(
      RazorpayService.verifyPayment({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: PAYMENT_ID,
        razorpay_signature: signature,
      })
    ).toBe(true);
  });

  it("rejects a tampered order_id (attacker re-uses a signature against a different order)", () => {
    const signature = signOrderPayment(ORDER_ID, PAYMENT_ID);
    expect(
      RazorpayService.verifyPayment({
        razorpay_order_id: "order_attackerOwned",
        razorpay_payment_id: PAYMENT_ID,
        razorpay_signature: signature,
      })
    ).toBe(false);
  });

  it("rejects a tampered payment_id", () => {
    const signature = signOrderPayment(ORDER_ID, PAYMENT_ID);
    expect(
      RazorpayService.verifyPayment({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: "pay_attackerOwned",
        razorpay_signature: signature,
      })
    ).toBe(false);
  });

  it("rejects an entirely fabricated signature of the correct length", () => {
    expect(
      RazorpayService.verifyPayment({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: PAYMENT_ID,
        razorpay_signature: "0".repeat(64),
      })
    ).toBe(false);
  });
});

describe("RazorpayService.verifyPayment — subscription flow", () => {
  const SUB_ID = "sub_NaJlYqQNoyfXjk";
  const PAYMENT_ID = "pay_NaJmHfRpQ9wXLm";

  it("accepts a correctly-signed subscription payment", () => {
    const signature = signSubscriptionPayment(PAYMENT_ID, SUB_ID);
    expect(
      RazorpayService.verifyPayment({
        razorpay_subscription_id: SUB_ID,
        razorpay_payment_id: PAYMENT_ID,
        razorpay_signature: signature,
      })
    ).toBe(true);
  });

  it("rejects subscription_id swapped to a different value", () => {
    const signature = signSubscriptionPayment(PAYMENT_ID, SUB_ID);
    expect(
      RazorpayService.verifyPayment({
        razorpay_subscription_id: "sub_attackerOwned",
        razorpay_payment_id: PAYMENT_ID,
        razorpay_signature: signature,
      })
    ).toBe(false);
  });

  it("does NOT accept an order-flow signature passed in the subscription slot", () => {
    // Guards against developer mistakes where the wrong sig formula is checked.
    const orderSig = signOrderPayment(SUB_ID, PAYMENT_ID);
    expect(
      RazorpayService.verifyPayment({
        razorpay_subscription_id: SUB_ID,
        razorpay_payment_id: PAYMENT_ID,
        razorpay_signature: orderSig,
      })
    ).toBe(false);
  });
});

describe("RazorpayService.verifyPayment — input safety", () => {
  it("returns false when neither order_id nor subscription_id is present", () => {
    expect(
      RazorpayService.verifyPayment({
        razorpay_payment_id: "pay_test",
        razorpay_signature: "deadbeef".repeat(8),
      })
    ).toBe(false);
  });

  it("does not throw on a length-mismatched signature", () => {
    // timingSafeEqual throws on length mismatch — must be caught internally.
    expect(() =>
      RazorpayService.verifyPayment({
        razorpay_order_id: "order_x",
        razorpay_payment_id: "pay_y",
        razorpay_signature: "deadbeef",
      })
    ).not.toThrow();

    expect(
      RazorpayService.verifyPayment({
        razorpay_order_id: "order_x",
        razorpay_payment_id: "pay_y",
        razorpay_signature: "deadbeef",
      })
    ).toBe(false);
  });

  it("does not throw on a non-hex signature", () => {
    expect(() =>
      RazorpayService.verifyPayment({
        razorpay_order_id: "order_x",
        razorpay_payment_id: "pay_y",
        razorpay_signature: "definitely-not-hex!!!",
      })
    ).not.toThrow();

    expect(
      RazorpayService.verifyPayment({
        razorpay_order_id: "order_x",
        razorpay_payment_id: "pay_y",
        razorpay_signature: "definitely-not-hex!!!",
      })
    ).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(
      RazorpayService.verifyPayment({
        razorpay_order_id: "order_x",
        razorpay_payment_id: "pay_y",
        razorpay_signature: "",
      })
    ).toBe(false);
  });
});

describe("RazorpayService.verifyWebhookSignature", () => {
  const SECRET = "whsec_test_secret_value";

  it("accepts a correctly-signed webhook body", () => {
    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_abc" } } },
    });
    const signature = signWebhook(body, SECRET);
    expect(RazorpayService.verifyWebhookSignature(body, signature, SECRET)).toBe(true);
  });

  it("rejects a tampered body (amount mutated by attacker)", () => {
    const original = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_abc", amount: 10000 } } },
    });
    const signature = signWebhook(original, SECRET);

    const tampered = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_abc", amount: 1 } } },
    });
    expect(RazorpayService.verifyWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a forged delivery signed with the wrong secret", () => {
    const body = JSON.stringify({ event: "payment.captured" });
    const signature = signWebhook(body, "attackers_guess");
    expect(RazorpayService.verifyWebhookSignature(body, signature, SECRET)).toBe(false);
  });

  it("rejects an empty signature", () => {
    const body = JSON.stringify({ event: "payment.captured" });
    expect(RazorpayService.verifyWebhookSignature(body, "", SECRET)).toBe(false);
  });

  it("rejects a non-hex signature", () => {
    const body = JSON.stringify({ event: "payment.captured" });
    expect(
      RazorpayService.verifyWebhookSignature(body, "not-a-real-signature", SECRET)
    ).toBe(false);
  });

  it("rejects when an attacker swaps the event but keeps the old signature", () => {
    const innocent = JSON.stringify({ event: "payment.failed" });
    const sig = signWebhook(innocent, SECRET);
    const malicious = JSON.stringify({ event: "payment.captured" });
    expect(RazorpayService.verifyWebhookSignature(malicious, sig, SECRET)).toBe(false);
  });
});
