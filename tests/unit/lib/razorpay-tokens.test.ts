/**
 * Tests for the Tokens-flow methods on RazorpayService (the Google /
 * Netflix ₹2-charge-and-reverse pattern). Coverage:
 *  - createCustomer happy path + propagates Razorpay errors via asRzpErr unwrap
 *  - createRecurringTokenOrder builds correct token shape per method
 *    (card-like vs eMandate/NACH); rejects < ₹1 validation amount
 *  - chargeViaToken does the 2-step (order + payment), enforces minimum,
 *    handles both `razorpay_payment_id` and `id` field names on the
 *    payment response defensively
 *  - refundPayment wraps razorpayClient.payments.refund with speed +
 *    notes, returns `null` paid amount when omitted
 *
 * The SDK is mocked via @/lib/razorpay-client so we control return values
 * per test. RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET are set before module
 * evaluation so the import-time guard in lib/razorpay-client.ts (which
 * throws if either is missing) doesn't fire during test bootstrap.
 *
 * See docs/razorpay-tokens-migration.md §4 for the API spec these methods
 * implement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_keyid";
  process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
});

// Hoisted mock fns so we can assert on them from each test
const mockCustomerCreate = vi.hoisted(() => vi.fn());
const mockOrderCreate = vi.hoisted(() => vi.fn());
const mockCreateRecurringPayment = vi.hoisted(() => vi.fn());
const mockRefund = vi.hoisted(() => vi.fn());

vi.mock("@/lib/razorpay-client", () => ({
  razorpayClient: {
    customers: { create: mockCustomerCreate },
    orders: { create: mockOrderCreate, fetch: vi.fn() },
    payments: {
      fetch: vi.fn(),
      refund: mockRefund,
      all: vi.fn(),
      createRecurringPayment: mockCreateRecurringPayment,
    },
    subscriptions: { create: vi.fn(), cancel: vi.fn() },
    plans: { create: vi.fn() },
  },
  razorpay: {},
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { RazorpayService } from "@/lib/razorpay";

beforeEach(() => {
  mockCustomerCreate.mockReset();
  mockOrderCreate.mockReset();
  mockCreateRecurringPayment.mockReset();
  mockRefund.mockReset();
});

describe("RazorpayService.createCustomer", () => {
  it("returns the customer object on success, passing fail_existing=0 for idempotency", async () => {
    mockCustomerCreate.mockResolvedValueOnce({
      id: "cust_abc123",
      entity: "customer",
      name: "Test User",
      email: "test@example.com",
      contact: "+919876543210",
      created_at: 1234567890,
    });

    const result = await RazorpayService.createCustomer({
      name: "Test User",
      email: "test@example.com",
      contact: "+919876543210",
      notes: { user_id: "u_123" },
    });

    expect(result.id).toBe("cust_abc123");
    expect(mockCustomerCreate).toHaveBeenCalledWith({
      name: "Test User",
      email: "test@example.com",
      contact: "+919876543210",
      fail_existing: 0,
      notes: { user_id: "u_123" },
    });
  });

  it("re-throws with the Razorpay error description when create fails", async () => {
    mockCustomerCreate.mockRejectedValueOnce({
      error: { code: "BAD_REQUEST", description: "Email already exists" },
    });

    await expect(
      RazorpayService.createCustomer({
        name: "Test User",
        email: "dup@example.com",
        contact: "+919876543210",
      })
    ).rejects.toThrow(/Email already exists/);
  });
});

describe("RazorpayService.createRecurringTokenOrder", () => {
  it("builds the card-token shape for method=card with caller-supplied frequency", async () => {
    mockOrderCreate.mockResolvedValueOnce({
      id: "order_token_abc",
      amount: 200,
      currency: "INR",
      receipt: "auth_test",
      status: "created",
      created_at: 1234567890,
    });

    await RazorpayService.createRecurringTokenOrder({
      customerId: "cust_abc123",
      maxAmountInPaise: 1500000,
      method: "card",
      frequency: "as_presented",
      receipt: "auth_test",
      notes: { intended_tier: "starter" },
    });

    const callArgs = mockOrderCreate.mock.calls[0][0];
    expect(callArgs.amount).toBe(200); // default ₹2 validation amount
    expect(callArgs.currency).toBe("INR");
    expect(callArgs.customer_id).toBe("cust_abc123");
    expect(callArgs.payment_capture).toBe(true);
    expect(callArgs.method).toBe("card");
    expect(callArgs.token.max_amount).toBe(1500000);
    expect(callArgs.token.frequency).toBe("as_presented");
    expect(typeof callArgs.token.expire_at).toBe("number");
    // Card-token shape has no auth_type
    expect(callArgs.token.auth_type).toBeUndefined();
  });

  it("builds the eMandate-token shape with auth_type=netbanking for method=emandate", async () => {
    mockOrderCreate.mockResolvedValueOnce({
      id: "order_token_em",
      amount: 200,
      currency: "INR",
      receipt: "auth_em",
      status: "created",
      created_at: 1234567890,
    });

    await RazorpayService.createRecurringTokenOrder({
      customerId: "cust_abc123",
      maxAmountInPaise: 9999900,
      method: "emandate",
      receipt: "auth_em",
    });

    const callArgs = mockOrderCreate.mock.calls[0][0];
    expect(callArgs.method).toBe("emandate");
    expect(callArgs.token.auth_type).toBe("netbanking");
    expect(callArgs.token.max_amount).toBe(9999900);
    // eMandate-token shape has no frequency
    expect(callArgs.token.frequency).toBeUndefined();
  });

  it("allows custom validationAmountInPaise above the ₹1 minimum", async () => {
    mockOrderCreate.mockResolvedValueOnce({
      id: "order_x",
      amount: 500,
      currency: "INR",
      receipt: "auth",
      status: "created",
      created_at: 0,
    });

    await RazorpayService.createRecurringTokenOrder({
      customerId: "cust_abc123",
      validationAmountInPaise: 500,
      maxAmountInPaise: 1500000,
      method: "card",
      receipt: "auth",
    });

    expect(mockOrderCreate.mock.calls[0][0].amount).toBe(500);
  });

  it("rejects validationAmountInPaise below 100 (Razorpay's ₹1 minimum)", async () => {
    await expect(
      RazorpayService.createRecurringTokenOrder({
        customerId: "cust_abc123",
        validationAmountInPaise: 50,
        maxAmountInPaise: 1500000,
        method: "card",
        receipt: "auth",
      })
    ).rejects.toThrow(/at least 100 paise/);
    expect(mockOrderCreate).not.toHaveBeenCalled();
  });

  it("re-throws with the Razorpay error description when create fails", async () => {
    mockOrderCreate.mockRejectedValueOnce({
      error: { description: "Invalid customer_id" },
    });
    await expect(
      RazorpayService.createRecurringTokenOrder({
        customerId: "cust_bad",
        maxAmountInPaise: 1500000,
        method: "card",
        receipt: "auth",
      })
    ).rejects.toThrow(/Invalid customer_id/);
  });
});

describe("RazorpayService.chargeViaToken", () => {
  it("creates an order then calls createRecurringPayment with the token; returns the payment id", async () => {
    mockOrderCreate.mockResolvedValueOnce({
      id: "order_mit_xyz",
      amount: 59988,
      currency: "INR",
      receipt: "mit_test",
      status: "created",
      created_at: 0,
    });
    mockCreateRecurringPayment.mockResolvedValueOnce({
      razorpay_payment_id: "pay_mit_xyz",
      razorpay_order_id: "order_mit_xyz",
      razorpay_signature: "sig",
    });

    const result = await RazorpayService.chargeViaToken({
      customerId: "cust_abc123",
      tokenId: "token_xyz",
      amountInRupees: 599.88,
      email: "test@example.com",
      contact: "+919876543210",
      receipt: "mit_test",
      description: "Starter yearly renewal",
    });

    expect(result).toEqual({
      orderId: "order_mit_xyz",
      paymentId: "pay_mit_xyz",
      amount: 59988,
    });

    // Verify both calls fired with the right shapes
    expect(mockOrderCreate).toHaveBeenCalledWith({
      amount: 59988,
      currency: "INR",
      customer_id: "cust_abc123",
      payment_capture: true,
      receipt: "mit_test",
      notes: undefined,
    });
    expect(mockCreateRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 59988,
        currency: "INR",
        order_id: "order_mit_xyz",
        customer_id: "cust_abc123",
        token: "token_xyz",
        recurring: true,
        description: "Starter yearly renewal",
      })
    );
  });

  it("falls back to payment.id when razorpay_payment_id is absent (defensive)", async () => {
    mockOrderCreate.mockResolvedValueOnce({
      id: "order_x",
      amount: 100,
      currency: "INR",
      receipt: "r",
      status: "created",
      created_at: 0,
    });
    mockCreateRecurringPayment.mockResolvedValueOnce({
      id: "pay_from_id_field",
      // No razorpay_payment_id
    });

    const result = await RazorpayService.chargeViaToken({
      customerId: "cust_abc",
      tokenId: "token_x",
      amountInRupees: 1,
      email: "t@example.com",
      contact: "+919876543210",
      receipt: "r",
    });
    expect(result.paymentId).toBe("pay_from_id_field");
  });

  it("throws when createRecurringPayment returns no payment id", async () => {
    mockOrderCreate.mockResolvedValueOnce({
      id: "order_x",
      amount: 100,
      currency: "INR",
      receipt: "r",
      status: "created",
      created_at: 0,
    });
    mockCreateRecurringPayment.mockResolvedValueOnce({}); // neither field

    await expect(
      RazorpayService.chargeViaToken({
        customerId: "cust_abc",
        tokenId: "token_x",
        amountInRupees: 1,
        email: "t@example.com",
        contact: "+919876543210",
        receipt: "r",
      })
    ).rejects.toThrow(/no payment id/);
  });

  it("rejects amountInRupees below ₹1", async () => {
    await expect(
      RazorpayService.chargeViaToken({
        customerId: "cust_abc",
        tokenId: "token_x",
        amountInRupees: 0.5, // 50 paise = below ₹1 floor
        email: "t@example.com",
        contact: "+919876543210",
        receipt: "r",
      })
    ).rejects.toThrow(/minimum ₹1/);
    expect(mockOrderCreate).not.toHaveBeenCalled();
    expect(mockCreateRecurringPayment).not.toHaveBeenCalled();
  });
});

describe("RazorpayService.refundPayment", () => {
  it("calls SDK refund with speed=optimum and the given amount + notes", async () => {
    mockRefund.mockResolvedValueOnce({
      id: "rfnd_abc",
      payment_id: "pay_xyz",
      amount: 200,
      status: "processed",
    });

    await RazorpayService.refundPayment("pay_xyz", 200, { reason: "test" });

    expect(mockRefund).toHaveBeenCalledWith("pay_xyz", {
      amount: 200,
      speed: "optimum",
      notes: { reason: "test" },
    });
  });

  it("omits the amount field when amountInPaise not provided (= full refund)", async () => {
    mockRefund.mockResolvedValueOnce({
      id: "rfnd_full",
      payment_id: "pay_yyy",
      amount: 1000,
      status: "processed",
    });

    await RazorpayService.refundPayment("pay_yyy");

    const callArgs = mockRefund.mock.calls[0][1];
    expect(callArgs.amount).toBeUndefined();
    expect(callArgs.speed).toBe("optimum");
  });

  it("re-throws with the Razorpay error description on failure", async () => {
    mockRefund.mockRejectedValueOnce({
      error: { description: "Payment is not in captured state" },
    });

    await expect(
      RazorpayService.refundPayment("pay_bad", 200)
    ).rejects.toThrow(/Payment is not in captured state/);
  });
});
