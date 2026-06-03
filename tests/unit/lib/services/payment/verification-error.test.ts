/**
 * Tests for `@/lib/services/payment/verification-error` (rescan-4
 * slice 7fd). Top-level error handler for /api/payments/verify. Pins:
 *  - 'Payment successful! ... is being processed' user-facing message
 *    is branched on cart composition: hosting-only / domain-only /
 *    both — UX matches what was actually charged
 *  - **Happy path (existingOrder in scope)**: Order.updateOne in place
 *    (preserves M4 post-provisioning state + real Razorpay tracking,
 *    doesn't duplicate the row); status stays 'processing' for
 *    admin / self-heal worker pickup; paymentVerification.paymentStatus
 *    pinned to 'captured_pending_support' so support can filter
 *  - Response stamps `requiresSupport: true` + paymentStatus:'success'
 *    + per-item registrationResults entries with status:'pending'
 *  - **Fallback path (no existingOrder)**: synthetic Order created
 *    with `ord_{timestamp}_{base36}` id; status:'processing' (NOT
 *    'completed' — nothing was actually registered); preserves real
 *    Razorpay ids when available, else literal 'fallback_order' /
 *    'fallback_payment' / 'fallback_signature' sentinels (still parseable
 *    by support; never confused with real razorpay ids since they
 *    don't have the expected prefix)
 *  - **User missing → re-throws original error** (cannot record
 *    failure state — caller's outer catch will surface the 500)
 *  - DB write failure during fallback → returns LAST-RESORT 500 with
 *    SUPPORT_EMAIL embedded
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const OrderCtor = vi.hoisted(() => vi.fn());
const Order = vi.hoisted(() => ({
  updateOne: vi.fn(),
}));
vi.mock("@/models/Order", () => ({
  default: Object.assign(
    function MockOrder(payload: unknown) {
      OrderCtor(payload);
      return {
        ...((payload as object) ?? {}),
        save: vi.fn().mockResolvedValue(undefined),
        purchaseOrderNumber: "PO-MOCK-1",
        orderId: (payload as { orderId?: string })?.orderId,
        invoiceNumber: undefined,
      };
    },
    Order
  ),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.unmock("next/server");
const { NextResponse } = await vi.importActual<typeof import("next/server")>(
  "next/server"
);
vi.doMock("next/server", () => ({ NextResponse }));

import { handleVerificationError } from "@/lib/services/payment/verification-error";

const USER = { _id: "USER_ID", email: "u@x.test" } as never;

const DOMAIN_ITEMS = [
  { domainName: "x.com", itemType: "domain", price: 500, registrationPeriod: 1 },
] as never;
const HOSTING_ITEMS = [
  { domainName: "hosting-1", itemType: "hosting", price: 999, registrationPeriod: 12 },
] as never;
const BUNDLE_ITEMS = [
  ...DOMAIN_ITEMS,
  ...HOSTING_ITEMS,
] as never;

beforeEach(() => {
  connectDB.mockReset();
  OrderCtor.mockReset();
  Order.updateOne.mockReset();
});

describe("handleVerificationError — user-facing message branching", () => {
  it("hosting-only cart → 'Hosting provisioning is being processed'", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    const result = await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: HOSTING_ITEMS,
      existingOrder: { _id: "O1", orderId: "ord_42" } as never,
    });
    const body = await result.json();
    expect(body.message).toMatch(/Hosting provisioning is being processed/);
  });

  it("domain-only cart → 'Domain registration is being processed'", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    const result = await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: DOMAIN_ITEMS,
      existingOrder: { _id: "O1", orderId: "ord_42" } as never,
    });
    const body = await result.json();
    expect(body.message).toMatch(/Domain registration is being processed/);
  });

  it("bundle cart (hosting + domain) → 'Service registration and provisioning is being processed'", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    const result = await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: BUNDLE_ITEMS,
      existingOrder: { _id: "O1", orderId: "ord_42" } as never,
    });
    const body = await result.json();
    expect(body.message).toMatch(
      /Service registration and provisioning is being processed/
    );
  });

  it("untyped items (no itemType) default to 'domain' branch", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    const result = await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: [
        { domainName: "x.com", price: 500, registrationPeriod: 1 },
      ] as never,
      existingOrder: { _id: "O1", orderId: "ord_42" } as never,
    });
    const body = await result.json();
    expect(body.message).toMatch(/Domain registration is being processed/);
  });
});

describe("handleVerificationError — existingOrder happy path (update in place)", () => {
  it("updates existing Order WITHOUT creating a new one", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: DOMAIN_ITEMS,
      existingOrder: { _id: "O1", orderId: "ord_42" } as never,
      razorpay_payment_id: "pay_xyz",
    });
    expect(Order.updateOne).toHaveBeenCalled();
    expect(OrderCtor).not.toHaveBeenCalled();
  });

  it("$set status:'processing' + paymentVerification.paymentStatus:'captured_pending_support'", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: DOMAIN_ITEMS,
      existingOrder: { _id: "O1", orderId: "ord_42" } as never,
      razorpay_payment_id: "pay_xyz",
    });
    const [filter, update] = Order.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "O1" });
    expect(update.$set.status).toBe("processing");
    expect(update.$set["paymentVerification.paymentStatus"]).toBe(
      "captured_pending_support"
    );
    expect(update.$set.razorpayPaymentId).toBe("pay_xyz");
  });

  it("razorpay_payment_id omitted → razorpayPaymentId NOT in $set (don't overwrite to undefined)", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: DOMAIN_ITEMS,
      existingOrder: { _id: "O1", orderId: "ord_42" } as never,
    });
    const [, update] = Order.updateOne.mock.calls[0];
    expect(update.$set.razorpayPaymentId).toBeUndefined();
  });

  it("response stamps requiresSupport:true + paymentStatus:'success' + per-item pending results", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    const result = await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: [
        { domainName: "x.com", itemType: "domain", price: 500 } as never,
        { domainName: "y.com", itemType: "domain", price: 500 } as never,
      ],
      existingOrder: {
        _id: "O1",
        orderId: "ord_42",
        invoiceNumber: "INV-1",
      } as never,
    });
    const body = await result.json();
    expect(body.success).toBe(true);
    expect(body.requiresSupport).toBe(true);
    expect(body.paymentStatus).toBe("success");
    expect(body.domainRegistrationStatus).toBe("pending");
    expect(body.orderId).toBe("ord_42");
    expect(body.invoiceNumber).toBe("INV-1");
    expect(body.registrationResults).toHaveLength(2);
    expect(body.registrationResults[0].status).toBe("pending");
    expect(body.pendingDomains).toEqual(["x.com", "y.com"]);
    expect(body.successfulDomains).toEqual([]);
  });
});

describe("handleVerificationError — fallback path (no existingOrder)", () => {
  it("creates synthetic Order with ord_{ts}_{base36} format + status:'processing'", async () => {
    const result = await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: DOMAIN_ITEMS,
      razorpay_order_id: "ord_rzp",
      razorpay_payment_id: "pay_rzp",
    });
    expect(OrderCtor).toHaveBeenCalled();
    const [payload] = OrderCtor.mock.calls[0];
    expect(payload.orderId).toMatch(/^ord_\d+_[a-z0-9]{1,6}$/);
    expect(payload.status).toBe("processing"); // NOT 'completed' — nothing was registered
    expect(payload.razorpayOrderId).toBe("ord_rzp");
    expect(payload.razorpayPaymentId).toBe("pay_rzp");
    // Smoke the response.
    const body = await result.json();
    expect(body.requiresSupport).toBe(true);
  });

  it("missing razorpay ids → literal 'fallback_order' / 'fallback_payment' / 'fallback_signature' sentinels", async () => {
    await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: DOMAIN_ITEMS,
    });
    const [payload] = OrderCtor.mock.calls[0];
    expect(payload.razorpayOrderId).toBe("fallback_order");
    expect(payload.razorpayPaymentId).toBe("fallback_payment");
    expect(payload.razorpaySignature).toBe("fallback_signature");
  });

  it("total amount = sum(price × registrationPeriod) over cartItems", async () => {
    await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: [
        { domainName: "x.com", price: 500, registrationPeriod: 1 } as never,
        { domainName: "y.com", price: 300, registrationPeriod: 2 } as never, // 600
      ],
    });
    const [payload] = OrderCtor.mock.calls[0];
    expect(payload.amount).toBe(500 + 600);
  });

  it("hosting periodUnit defaults to 'months', domain periodUnit defaults to 'years'", async () => {
    await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: [
        { domainName: "x.com", itemType: "domain", price: 500 } as never,
        { domainName: "hosting-1", itemType: "hosting", price: 999 } as never,
      ],
    });
    const [payload] = OrderCtor.mock.calls[0];
    expect(payload.domains[0].periodUnit).toBe("years"); // domain
    expect(payload.domains[1].periodUnit).toBe("months"); // hosting
  });

  it("paymentVerification.paymentStatus = 'captured_pending_support' on fallback too", async () => {
    await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: DOMAIN_ITEMS,
    });
    const [payload] = OrderCtor.mock.calls[0];
    expect(payload.paymentVerification.paymentStatus).toBe(
      "captured_pending_support"
    );
  });

  it("each domain row gets bookingStatus[0] = payment_verified at progress:30", async () => {
    await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: DOMAIN_ITEMS,
    });
    const [payload] = OrderCtor.mock.calls[0];
    const step = payload.domains[0].bookingStatus[0];
    expect(step.step).toBe("payment_verified");
    expect(step.progress).toBe(30);
  });
});

describe("handleVerificationError — last-resort paths", () => {
  it("user missing → returns last-resort 500 with SUPPORT_EMAIL", async () => {
    const result = await handleVerificationError({
      error: new Error("rc broke"),
      user: null,
      cartItems: DOMAIN_ITEMS,
    });
    expect(result.status).toBe(500);
    const body = await result.json();
    expect(body.success).toBe(false);
    expect(body.errorType).toBe("verification_error");
    expect(body.supportContact).toContain("@");
    // Original 'rc broke' error MUST NOT leak.
    expect(body.error).not.toMatch(/rc broke/);
  });

  it("DB write throw during update → returns last-resort 500", async () => {
    Order.updateOne.mockRejectedValueOnce(new Error("write conflict"));
    const result = await handleVerificationError({
      error: new Error("rc broke"),
      user: USER,
      cartItems: DOMAIN_ITEMS,
      existingOrder: { _id: "O1", orderId: "ord_42" } as never,
    });
    expect(result.status).toBe(500);
    const body = await result.json();
    expect(body.errorType).toBe("verification_error");
  });
});
