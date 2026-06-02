/**
 * Tests for `@/lib/email/billing` (rescan-4 slice 7em).
 * Billing-flow email templates. The subject lines are critical UX
 * surface — they appear in the user's inbox preview. Pins:
 *  - **sendPurchaseOrderEmail subject 3-way branch**:
 *    - paymentStatus:'success' + registrationFailed:true →
 *      "Purchase Order - PO123 (Registration Failed)"
 *    - paymentStatus:'success' + registrationFailed:false → "Purchase Order - PO123"
 *    - paymentStatus:'failed' → "Purchase Order - PO123 (Payment Failed)"
 *  - **sendOrderConfirmationEmail subject 4-way branch** based on
 *    successful + pending domain mix:
 *    - all successful → "Order Confirmation - INV"
 *    - all pending or all-pending-OR-successful → "Payment Successful - INV"
 *    - both successful + pending → "Payment Successful - INV"
 *    - neither pure successful nor pending-only → "Payment Received - INV"
 *  - sendAdminNotification prepends "[Admin] " to subject (so admin
 *    inbox filters can route)
 *  - sendLowBalanceAlert:
 *    - balance < threshold * 0.5 → "[CRITICAL]" prefix
 *    - else → "[Warning]" prefix
 *    - Balance amount in subject is .toFixed(2) (₹XX.XX)
 *  - All template fns route through sendEmail and propagate its return
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmailMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("@/lib/email/transporter", () => ({
  sendEmail: sendEmailMock,
  SUPPORT_EMAIL: "support@anutech.in",
}));

vi.mock("@/lib/dateUtils", () => ({
  formatIndianDateTime: (d: Date) => d.toISOString(),
}));

import {
  sendPurchaseOrderEmail,
  sendOrderConfirmationEmail,
  sendAdminNotification,
  sendLowBalanceAlert,
} from "@/lib/email/billing";

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(true);
});

function poData(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "ORD_42",
    purchaseOrderNumber: "PO_123",
    invoiceNumber: "INV-1",
    amount: 1000,
    subtotal: 900,
    currency: "INR",
    paymentStatus: "success" as const,
    paymentId: "pay_xyz",
    createdAt: new Date("2026-06-01"),
    domains: [
      {
        domainName: "x.com",
        price: 500,
        registrationPeriod: 1,
      },
    ],
    ...overrides,
  };
}

function ocData(
  successful: Array<{ domainName: string; price: number; registrationPeriod: number }>,
  all: Array<{ domainName: string; price: number; registrationPeriod: number; status: string }>
) {
  return {
    orderId: "ORD_42",
    purchaseOrderNumber: "PO_123",
    invoiceNumber: "INV-1",
    amount: 1000,
    currency: "INR",
    successfulDomains: successful,
    allDomains: all,
    paymentId: "pay_xyz",
    createdAt: new Date("2026-06-01"),
  };
}

describe("sendPurchaseOrderEmail — 3-way subject branch", () => {
  it("payment success + registration FAILED → '(Registration Failed)' suffix", async () => {
    await sendPurchaseOrderEmail("user@x.test", "Alice", poData({
      paymentStatus: "success",
      registrationFailed: true,
    }));
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Purchase Order - PO_123 (Registration Failed)"
    );
  });

  it("payment success + registration OK → bare 'Purchase Order' subject", async () => {
    await sendPurchaseOrderEmail("user@x.test", "Alice", poData({
      paymentStatus: "success",
      registrationFailed: false,
    }));
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Purchase Order - PO_123"
    );
  });

  it("payment FAILED → '(Payment Failed)' suffix", async () => {
    await sendPurchaseOrderEmail("user@x.test", "Alice", poData({
      paymentStatus: "failed",
    }));
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Purchase Order - PO_123 (Payment Failed)"
    );
  });

  it("recipient = userEmail param + propagates sendEmail return", async () => {
    sendEmailMock.mockResolvedValueOnce(false);
    const result = await sendPurchaseOrderEmail(
      "specific@x.test",
      "Alice",
      poData()
    );
    expect(result).toBe(false);
    expect(sendEmailMock.mock.calls[0][0].to).toBe("specific@x.test");
  });
});

describe("sendOrderConfirmationEmail — 4-way subject branch on domain mix", () => {
  it("ALL successful (no pending) → 'Order Confirmation - INV'", async () => {
    await sendOrderConfirmationEmail(
      "user@x.test",
      "Alice",
      ocData(
        [{ domainName: "x.com", price: 500, registrationPeriod: 1 }],
        [{ domainName: "x.com", price: 500, registrationPeriod: 1, status: "registered" }]
      )
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Order Confirmation - INV-1"
    );
  });

  it("all pending (only-pending-or-successful) → 'Payment Successful - INV'", async () => {
    await sendOrderConfirmationEmail(
      "user@x.test",
      "Alice",
      ocData(
        [],
        [{ domainName: "x.com", price: 500, registrationPeriod: 1, status: "pending" }]
      )
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Payment Successful - INV-1"
    );
  });

  it("BOTH successful + pending → 'Payment Successful - INV'", async () => {
    await sendOrderConfirmationEmail(
      "user@x.test",
      "Alice",
      ocData(
        [{ domainName: "x.com", price: 500, registrationPeriod: 1 }],
        [
          { domainName: "x.com", price: 500, registrationPeriod: 1, status: "registered" },
          { domainName: "y.com", price: 500, registrationPeriod: 1, status: "pending" },
        ]
      )
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Payment Successful - INV-1"
    );
  });

  it("a mix that includes 'failed' → fallback 'Payment Received - INV'", async () => {
    await sendOrderConfirmationEmail(
      "user@x.test",
      "Alice",
      ocData(
        [],
        [{ domainName: "x.com", price: 500, registrationPeriod: 1, status: "failed" }]
      )
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Payment Received - INV-1"
    );
  });
});

describe("sendAdminNotification", () => {
  it("subject prefixed with '[Admin] ' (drives inbox filters)", async () => {
    await sendAdminNotification(
      "admin@x.test",
      "New Order",
      "An order was placed"
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe("[Admin] New Order");
    expect(sendEmailMock.mock.calls[0][0].to).toBe("admin@x.test");
  });

  it("data payload JSON-stringified into the HTML body", async () => {
    await sendAdminNotification(
      "admin@x.test",
      "New Order",
      "An order was placed",
      { orderId: "ORD_42", customerEmail: "u@x.test" }
    );
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.html).toContain("ORD_42");
    expect(opts.html).toContain("u@x.test");
  });
});

describe("sendLowBalanceAlert — CRITICAL vs Warning threshold", () => {
  it("balance < threshold*0.5 → '[CRITICAL]' prefix in subject", async () => {
    await sendLowBalanceAlert("admin@x.test", {
      availableBalance: "100.00",
      threshold: 1000,
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/\[CRITICAL\]/);
  });

  it("balance between threshold*0.5 and threshold → '[Warning]' prefix", async () => {
    await sendLowBalanceAlert("admin@x.test", {
      availableBalance: "600.00",
      threshold: 1000,
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/\[Warning\]/);
    expect(sendEmailMock.mock.calls[0][0].subject).not.toMatch(/\[CRITICAL\]/);
  });

  it("balance amount in subject is .toFixed(2) format", async () => {
    await sendLowBalanceAlert("admin@x.test", {
      availableBalance: "123.456789",
      threshold: 1000,
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toContain("₹123.46");
  });

  it("optional reseller fields rendered into the HTML body when present", async () => {
    await sendLowBalanceAlert("admin@x.test", {
      availableBalance: "100.00",
      threshold: 1000,
      resellerName: "MyReseller",
      resellerId: "RC_42",
    });
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.html).toContain("MyReseller");
    expect(opts.html).toContain("RC_42");
  });
});
