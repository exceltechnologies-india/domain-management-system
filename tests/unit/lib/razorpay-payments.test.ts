/**
 * Tests for `@/lib/razorpay-payments` (rescan-4 slice 7dy).
 * Razorpay payment-listing + domain-filtering helpers. Pins:
 *  - getAllPayments forwards count + skip to razorpayClient.payments.all
 *  - getPaymentsByDateRange adds from + to as **Unix-second epochs**
 *    (Razorpay's wire format — floor(ms/1000), not the JS-native ms)
 *  - SDK throws are logged + rethrown
 *  - filterDomainPayments OR-combines 4 detection signals (description
 *    contains 'ord_', notes has domain fields, amount in paise range,
 *    failed-payment with any of the above)
 *  - getDomainPaymentDetails extracts orderId via regex from
 *    description; falls back to notes.orderId; domainNames falls back
 *    through 3 shapes; customerEmail falls back to payment.email
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const paymentsAllMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay-client", () => ({
  razorpayClient: { payments: { all: paymentsAllMock } },
}));

const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: loggerError, info: vi.fn(), warn: vi.fn() },
}));

import { RazorpayPaymentsService } from "@/lib/razorpay-payments";
import type { RazorpayPayment } from "@/lib/razorpay-payments";

beforeEach(() => {
  paymentsAllMock.mockReset();
  loggerError.mockReset();
});

function payment(overrides: Partial<RazorpayPayment> = {}): RazorpayPayment {
  return {
    id: "pay_default",
    entity: "payment",
    amount: 100000,
    currency: "INR",
    status: "captured",
    method: "card",
    captured: true,
    created_at: 0,
    ...overrides,
  } as RazorpayPayment;
}

describe("getAllPayments", () => {
  it("forwards count + skip to razorpayClient.payments.all (defaults 100/0)", async () => {
    paymentsAllMock.mockResolvedValueOnce({ entity: "collection", count: 0, items: [] });
    await RazorpayPaymentsService.getAllPayments();
    expect(paymentsAllMock).toHaveBeenCalledWith({ count: 100, skip: 0 });
  });

  it("respects custom limit + skip", async () => {
    paymentsAllMock.mockResolvedValueOnce({ entity: "collection", count: 0, items: [] });
    await RazorpayPaymentsService.getAllPayments(25, 50);
    expect(paymentsAllMock).toHaveBeenCalledWith({ count: 25, skip: 50 });
  });

  it("SDK throws are logged + rethrown", async () => {
    paymentsAllMock.mockRejectedValueOnce(new Error("rate limit"));
    await expect(RazorpayPaymentsService.getAllPayments()).rejects.toThrow("rate limit");
    expect(loggerError).toHaveBeenCalled();
  });
});

describe("getPaymentsByDateRange", () => {
  it("converts JS Date → Unix seconds via floor(ms/1000) for the Razorpay wire format", async () => {
    paymentsAllMock.mockResolvedValueOnce({ entity: "collection", count: 0, items: [] });
    const from = new Date("2026-01-01T00:00:00Z"); // ms = 1767225600000 → s = 1767225600
    const to = new Date("2026-02-01T00:00:00Z");
    await RazorpayPaymentsService.getPaymentsByDateRange(from, to);
    const [args] = paymentsAllMock.mock.calls[0];
    expect(args.from).toBe(Math.floor(from.getTime() / 1000));
    expect(args.to).toBe(Math.floor(to.getTime() / 1000));
    expect(args.count).toBe(100);
    expect(args.skip).toBe(0);
  });

  it("SDK throws are logged + rethrown", async () => {
    paymentsAllMock.mockRejectedValueOnce(new Error("rate limit"));
    await expect(
      RazorpayPaymentsService.getPaymentsByDateRange(new Date(), new Date())
    ).rejects.toThrow("rate limit");
    expect(loggerError).toHaveBeenCalled();
  });
});

describe("filterDomainPayments", () => {
  it("matches when description contains 'ord_'", () => {
    const result = RazorpayPaymentsService.filterDomainPayments([
      payment({ description: "Order ord_1234567890_abc payment" }),
    ]);
    expect(result).toHaveLength(1);
  });

  it("matches when notes carry domain-related fields", () => {
    const result = RazorpayPaymentsService.filterDomainPayments([
      payment({ notes: { domainName: "example.com" } as never }),
      payment({ notes: { orderId: "ord_xyz" } as never }),
      payment({ notes: { domains: ["a.com", "b.com"] } as never }),
    ]);
    expect(result).toHaveLength(3);
  });

  it("matches when amount is in the reasonable domain-pricing range (₹100-₹10000 in paise)", () => {
    const result = RazorpayPaymentsService.filterDomainPayments([
      payment({ amount: 10000 }), // ₹100
      payment({ amount: 1000000 }), // ₹10000
      payment({ amount: 500000 }), // ₹5000 — inside range
    ]);
    expect(result).toHaveLength(3);
  });

  it("excludes payments with no signal at all (amount below ₹100 + no notes/desc)", () => {
    const result = RazorpayPaymentsService.filterDomainPayments([
      payment({ amount: 5000, description: undefined, notes: undefined as never }),
    ]);
    expect(result).toHaveLength(0);
  });

  it("includes failed payments that have ANY domain-related signal", () => {
    const result = RazorpayPaymentsService.filterDomainPayments([
      payment({
        status: "failed",
        amount: 100000,
        description: "ord_abc",
      }),
    ]);
    expect(result).toHaveLength(1);
  });
});

describe("getDomainPaymentDetails", () => {
  it("extracts orderId via regex from the description (ord_\\d+_\\w+)", async () => {
    const result = await RazorpayPaymentsService.getDomainPaymentDetails(
      payment({ description: "Payment for ord_1234567890_abc — domain x.com" })
    );
    expect(result.orderId).toBe("ord_1234567890_abc");
  });

  it("falls back to notes.orderId when description doesn't have one", async () => {
    const result = await RazorpayPaymentsService.getDomainPaymentDetails(
      payment({ description: "plain", notes: { orderId: "ord_from_notes" } as never })
    );
    expect(result.orderId).toBe("ord_from_notes");
  });

  it("domainNames: prefers notes.domainNames > notes.domainName (wrapped) > notes.domains", async () => {
    // domainNames array directly.
    const a = await RazorpayPaymentsService.getDomainPaymentDetails(
      payment({ notes: { domainNames: ["a.com", "b.com"] } as never })
    );
    expect(a.domainNames).toEqual(["a.com", "b.com"]);

    // Singular domainName → wrapped in array.
    const b = await RazorpayPaymentsService.getDomainPaymentDetails(
      payment({ notes: { domainName: "single.com" } as never })
    );
    expect(b.domainNames).toEqual(["single.com"]);
  });

  it("customerEmail falls back to payment.email when notes.customerEmail is absent", async () => {
    const result = await RazorpayPaymentsService.getDomainPaymentDetails(
      payment({ email: "u@example.test" })
    );
    expect(result.customerEmail).toBe("u@example.test");
  });

  it("customerEmail in notes wins over payment.email", async () => {
    const result = await RazorpayPaymentsService.getDomainPaymentDetails(
      payment({
        email: "payment-level@x.test",
        notes: { customerEmail: "notes-level@x.test" } as never,
      })
    );
    expect(result.customerEmail).toBe("notes-level@x.test");
  });

  it("payment object is returned unchanged in the result", async () => {
    const p = payment({ id: "pay_xyz" });
    const result = await RazorpayPaymentsService.getDomainPaymentDetails(p);
    expect(result.payment).toBe(p);
  });
});
