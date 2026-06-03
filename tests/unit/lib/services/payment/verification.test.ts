/**
 * Tests for `@/lib/services/payment/verification` (rescan-4 slice 7ff).
 * 4-step Razorpay payment verification: HMAC signature → fetch
 * paymentDetails → status check → order/subscription id cross-check.
 * Plus the F3 amount-mismatch fraud guard. Pins:
 *  - **Signature check first** (cheap local HMAC, no network call)
 *  - Invalid signature → 400 'Invalid payment signature' WITHOUT
 *    fetching paymentDetails
 *  - getPaymentDetails throw → 400 'Failed to verify payment status'
 *  - **Status must be 'captured' OR 'authorized'** — anything else
 *    (failed/refunded/created) → 400 with the actual status named
 *  - Order id cross-check: when razorpay_order_id supplied, must
 *    match paymentDetails.order_id (defence vs replay-from-different-
 *    order)
 *  - Subscription id cross-check: same defence for subscription flow;
 *    BUT when razorpay_subscription_id supplied but paymentDetails
 *    LACKS one → warn + proceed (subscription metadata sometimes
 *    arrives out-of-band, signature is the real authority)
 *  - **F3 amount-mismatch guard** (`validateOrderAmountMatchesRazorpay`):
 *    DB amount × 100 must === Razorpay order amount (paise); mismatch
 *    → 400 'Payment amount does not match order' (defence vs client
 *    signing a payment for less than the cart total — underpayment fraud)
 *  - getOrderDetails throw → 400 'Could not verify payment amount'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyPayment = vi.hoisted(() => vi.fn());
const getPaymentDetails = vi.hoisted(() => vi.fn());
const getOrderDetails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { verifyPayment, getPaymentDetails, getOrderDetails },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.unmock("next/server");
const { NextResponse } = await vi.importActual<typeof import("next/server")>(
  "next/server"
);
vi.doMock("next/server", () => ({ NextResponse }));

import {
  verifyRazorpayPayment,
  validateOrderAmountMatchesRazorpay,
} from "@/lib/services/payment/verification";

beforeEach(() => {
  verifyPayment.mockReset();
  getPaymentDetails.mockReset();
  getOrderDetails.mockReset();
});

describe("verifyRazorpayPayment — 4-step pipeline", () => {
  it("invalid signature → 400 'Invalid payment signature' WITHOUT fetching paymentDetails", async () => {
    verifyPayment.mockReturnValueOnce(false);
    const result = await verifyRazorpayPayment({
      razorpay_order_id: "ord_42",
      razorpay_payment_id: "pay_xyz",
      razorpay_signature: "sig_invalid",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toBe("Invalid payment signature");
    }
    expect(getPaymentDetails).not.toHaveBeenCalled();
  });

  it("getPaymentDetails throw → 400 'Failed to verify payment status'", async () => {
    verifyPayment.mockReturnValueOnce(true);
    getPaymentDetails.mockRejectedValueOnce(new Error("Razorpay 503"));
    const result = await verifyRazorpayPayment({
      razorpay_order_id: "ord_42",
      razorpay_payment_id: "pay_xyz",
      razorpay_signature: "sig",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = await result.response.json();
      expect(body.error).toBe("Failed to verify payment status");
    }
  });

  it("happy path: status:'captured' + matching order_id → ok:true with paymentDetails", async () => {
    verifyPayment.mockReturnValueOnce(true);
    getPaymentDetails.mockResolvedValueOnce({
      id: "pay_xyz",
      status: "captured",
      amount: 50000,
      order_id: "ord_42",
    });
    const result = await verifyRazorpayPayment({
      razorpay_order_id: "ord_42",
      razorpay_payment_id: "pay_xyz",
      razorpay_signature: "sig",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paymentDetails.status).toBe("captured");
    }
  });

  it("'authorized' status ALSO accepted (not yet captured but verifiable)", async () => {
    verifyPayment.mockReturnValueOnce(true);
    getPaymentDetails.mockResolvedValueOnce({
      id: "pay_xyz",
      status: "authorized",
      amount: 50000,
      order_id: "ord_42",
    });
    const result = await verifyRazorpayPayment({
      razorpay_order_id: "ord_42",
      razorpay_payment_id: "pay_xyz",
      razorpay_signature: "sig",
    });
    expect(result.ok).toBe(true);
  });

  it("any other status (failed/refunded/created) → 400 with the actual status named", async () => {
    verifyPayment.mockReturnValue(true);
    for (const status of ["failed", "refunded", "created"]) {
      getPaymentDetails.mockResolvedValueOnce({
        id: "pay_xyz",
        status,
        amount: 50000,
        order_id: "ord_42",
      });
      const result = await verifyRazorpayPayment({
        razorpay_order_id: "ord_42",
        razorpay_payment_id: "pay_xyz",
        razorpay_signature: "sig",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const body = await result.response.json();
        expect(body.error).toContain(`Payment status is ${status}`);
      }
    }
  });

  it("ORDER ID MISMATCH → 400 'Order ID mismatch' (defence vs replay-from-different-order)", async () => {
    verifyPayment.mockReturnValueOnce(true);
    getPaymentDetails.mockResolvedValueOnce({
      id: "pay_xyz",
      status: "captured",
      amount: 50000,
      order_id: "ord_DIFFERENT", // <-- mismatch
    });
    const result = await verifyRazorpayPayment({
      razorpay_order_id: "ord_42",
      razorpay_payment_id: "pay_xyz",
      razorpay_signature: "sig",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = await result.response.json();
      expect(body.error).toBe("Order ID mismatch");
    }
  });

  it("SUBSCRIPTION ID MISMATCH → 400 'Subscription ID mismatch'", async () => {
    verifyPayment.mockReturnValueOnce(true);
    getPaymentDetails.mockResolvedValueOnce({
      id: "pay_xyz",
      status: "captured",
      amount: 50000,
      subscription_id: "sub_DIFFERENT",
    });
    const result = await verifyRazorpayPayment({
      razorpay_subscription_id: "sub_42",
      razorpay_payment_id: "pay_xyz",
      razorpay_signature: "sig",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = await result.response.json();
      expect(body.error).toBe("Subscription ID mismatch");
    }
  });

  it("subscription_id supplied BUT paymentDetails lacks one → WARN + proceed (signature is the authority)", async () => {
    verifyPayment.mockReturnValueOnce(true);
    getPaymentDetails.mockResolvedValueOnce({
      id: "pay_xyz",
      status: "captured",
      amount: 50000,
      // no subscription_id in paymentDetails
    });
    const result = await verifyRazorpayPayment({
      razorpay_subscription_id: "sub_42",
      razorpay_payment_id: "pay_xyz",
      razorpay_signature: "sig",
    });
    expect(result.ok).toBe(true); // still proceeds
  });

  it("order_id NOT supplied (subscription-only flow) → skip order cross-check", async () => {
    verifyPayment.mockReturnValueOnce(true);
    getPaymentDetails.mockResolvedValueOnce({
      id: "pay_xyz",
      status: "captured",
      amount: 50000,
      order_id: "anything", // doesn't matter — no expected order_id supplied
    });
    const result = await verifyRazorpayPayment({
      razorpay_subscription_id: "sub_42",
      razorpay_payment_id: "pay_xyz",
      razorpay_signature: "sig",
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateOrderAmountMatchesRazorpay — F3 underpayment-fraud guard", () => {
  it("DB amount × 100 === Razorpay paise → ok:true (no response)", async () => {
    getOrderDetails.mockResolvedValueOnce({ amount: 50000 }); // 500 rupees in paise
    const result = await validateOrderAmountMatchesRazorpay("ord_42", {
      amount: 500,
    });
    expect(result.ok).toBe(true);
  });

  it("DB amount × 100 !== Razorpay paise → 400 'Payment amount does not match order'", async () => {
    // DB expects 500 rupees (50000 paise) but Razorpay was charged 300 (30000)
    getOrderDetails.mockResolvedValueOnce({ amount: 30000 });
    const result = await validateOrderAmountMatchesRazorpay("ord_42", {
      amount: 500,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toBe("Payment amount does not match order");
    }
  });

  it("Math.round() applied to DB amount (defence vs float-precision drift)", async () => {
    // 500.001 × 100 = 50000.1 → round to 50000
    getOrderDetails.mockResolvedValueOnce({ amount: 50000 });
    const result = await validateOrderAmountMatchesRazorpay("ord_42", {
      amount: 500.001,
    });
    expect(result.ok).toBe(true);
  });

  it("Razorpay amount as string → Number() coercion + comparison", async () => {
    getOrderDetails.mockResolvedValueOnce({ amount: "50000" }); // string from RC
    const result = await validateOrderAmountMatchesRazorpay("ord_42", {
      amount: 500,
    });
    expect(result.ok).toBe(true);
  });

  it("getOrderDetails throw → 400 'Could not verify payment amount'", async () => {
    getOrderDetails.mockRejectedValueOnce(new Error("Razorpay 503"));
    const result = await validateOrderAmountMatchesRazorpay("ord_42", {
      amount: 500,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toBe("Could not verify payment amount");
    }
  });
});
