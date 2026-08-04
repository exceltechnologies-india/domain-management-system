/**
 * Tests for retryFailedMandateRefunds — the sweep that re-attempts ₹2 trial
 * mandate refunds left in mandateRefundStatus='failed' by a transient
 * webhook-time rejection.
 *
 * Pins:
 *  - fresh retry succeeds → order flips to 'processed' + refundId + save
 *  - idempotency: Razorpay already refunded → reconcile, NO second refund
 *  - skip: synthetic/legacy paymentId (not a real Razorpay id) is never sent
 *    to the refund API
 *  - still-failing: a re-rejection leaves the order 'failed' (retried next run),
 *    never crashes the sweep
 *  - empty: no failed orders → all-zero, no Razorpay calls
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findOrderDocs = vi.hoisted(() => vi.fn());
const OrderFind = vi.hoisted(() =>
  vi.fn(() => ({ sort: () => ({ limit: () => findOrderDocs() }) }))
);
vi.mock("@/models/Order", () => ({ default: { find: OrderFind }, __esModule: true }));

vi.mock("@/lib/mongodb", () => ({ default: vi.fn().mockResolvedValue(undefined) }));

const getPaymentDetails = vi.hoisted(() => vi.fn());
const refundPayment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { getPaymentDetails, refundPayment },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { retryFailedMandateRefunds } from "@/lib/services/payment/mandate-refund-retry";

function makeOrder(over: Record<string, unknown> = {}) {
  return {
    orderId: "ord_x",
    razorpayPaymentId: "pay_TLeQRUtq6LExX7",
    mandateRefundStatus: "failed",
    mandateRefundId: undefined as string | undefined,
    mandateRefundedAt: undefined as Date | undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("retryFailedMandateRefunds", () => {
  it("fresh retry succeeds → order reconciled to processed", async () => {
    const order = makeOrder();
    findOrderDocs.mockResolvedValue([order]);
    getPaymentDetails.mockResolvedValue({ amount_refunded: 0 });
    refundPayment.mockResolvedValue({ id: "rfnd_1" });

    const r = await retryFailedMandateRefunds();

    expect(r).toEqual({ scanned: 1, refunded: 1, alreadyRefunded: 0, skipped: 0, stillFailing: 0 });
    expect(refundPayment).toHaveBeenCalledWith(
      "pay_TLeQRUtq6LExX7",
      undefined,
      expect.objectContaining({ orderId: "ord_x", reason: "mandate_validation_refund_retry" })
    );
    expect(order.mandateRefundStatus).toBe("processed");
    expect(order.mandateRefundId).toBe("rfnd_1");
    expect(order.save).toHaveBeenCalledOnce();
  });

  it("idempotent: Razorpay already refunded → reconcile, NO second refund", async () => {
    const order = makeOrder();
    findOrderDocs.mockResolvedValue([order]);
    getPaymentDetails.mockResolvedValue({ amount_refunded: 200 });

    const r = await retryFailedMandateRefunds();

    expect(r).toEqual({ scanned: 1, refunded: 0, alreadyRefunded: 1, skipped: 0, stillFailing: 0 });
    expect(refundPayment).not.toHaveBeenCalled();
    expect(order.mandateRefundStatus).toBe("processed");
    expect(order.save).toHaveBeenCalledOnce();
  });

  it("skips a synthetic/legacy paymentId — never hits the refund API", async () => {
    const order = makeOrder({ razorpayPaymentId: "pay_1785837394098_9boc9s" });
    findOrderDocs.mockResolvedValue([order]);

    const r = await retryFailedMandateRefunds();

    expect(r).toEqual({ scanned: 1, refunded: 0, alreadyRefunded: 0, skipped: 1, stillFailing: 0 });
    expect(getPaymentDetails).not.toHaveBeenCalled();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(order.mandateRefundStatus).toBe("failed");
    expect(order.save).not.toHaveBeenCalled();
  });

  it("skips an order with no razorpayPaymentId", async () => {
    const order = makeOrder({ razorpayPaymentId: undefined });
    findOrderDocs.mockResolvedValue([order]);

    const r = await retryFailedMandateRefunds();

    expect(r.skipped).toBe(1);
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it("still-failing: a re-rejection leaves the order failed, sweep continues", async () => {
    const order = makeOrder();
    findOrderDocs.mockResolvedValue([order]);
    getPaymentDetails.mockResolvedValue({ amount_refunded: 0 });
    refundPayment.mockRejectedValue(new Error("payment is being processed"));

    const r = await retryFailedMandateRefunds();

    expect(r).toEqual({ scanned: 1, refunded: 0, alreadyRefunded: 0, skipped: 0, stillFailing: 1 });
    expect(order.mandateRefundStatus).toBe("failed");
    expect(order.save).not.toHaveBeenCalled();
  });

  it("no failed orders → all-zero, no Razorpay calls", async () => {
    findOrderDocs.mockResolvedValue([]);

    const r = await retryFailedMandateRefunds();

    expect(r).toEqual({ scanned: 0, refunded: 0, alreadyRefunded: 0, skipped: 0, stillFailing: 0 });
    expect(getPaymentDetails).not.toHaveBeenCalled();
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it("processes a mixed batch independently", async () => {
    const ok = makeOrder({ orderId: "ord_ok" });
    const dup = makeOrder({ orderId: "ord_dup" });
    const bad = makeOrder({ orderId: "ord_bad", razorpayPaymentId: "pay_123_synthetic" });
    findOrderDocs.mockResolvedValue([ok, dup, bad]);
    // ok → fresh refund; dup → already refunded; bad → skipped
    getPaymentDetails
      .mockResolvedValueOnce({ amount_refunded: 0 }) // ok
      .mockResolvedValueOnce({ amount_refunded: 200 }); // dup
    refundPayment.mockResolvedValue({ id: "rfnd_ok" });

    const r = await retryFailedMandateRefunds();

    expect(r).toEqual({ scanned: 3, refunded: 1, alreadyRefunded: 1, skipped: 1, stillFailing: 0 });
    expect(ok.mandateRefundStatus).toBe("processed");
    expect(dup.mandateRefundStatus).toBe("processed");
    expect(bad.mandateRefundStatus).toBe("failed");
  });
});
