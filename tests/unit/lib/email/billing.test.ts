/**
 * Tests for `@/lib/email/billing` (rescan-4 slice 7em).
 * Billing-flow email templates. The subject lines are critical UX
 * surface — they appear in the user's inbox preview. Pins:
 *  - **sendPurchaseOrderEmail subject 3-way branch**:
 *    - paymentStatus:'success' + registrationFailed:true →
 *      "Payment received, but registration failed — purchase order PO123"
 *    - paymentStatus:'success' + registrationFailed:false → "Payment received — purchase order PO123"
 *    - paymentStatus:'failed' → "Your payment didn't go through — purchase order PO123"
 *  - **sendOrderConfirmationEmail subject 4-way branch** based on
 *    successful + pending domain mix:
 *    - all successful → "Your order is confirmed — invoice INV"
 *    - all pending or all-pending-OR-successful → "Payment received — invoice INV"
 *    - both successful + pending → "Payment received — invoice INV"
 *    - neither pure successful nor pending-only →
 *      "Payment received — we're looking into your order, invoice INV"
 *  - Both customer emails are in the ResellerOS plain pattern (lib/email/plain.ts;
 *    Pawan, 3 Oct 2026): "Hi <first name>,", the order facts as indented text lines,
 *    the support address, signed "— <brand>"; no banners, tables or emoji.
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
  it("payment success + registration FAILED → 'registration failed' subject", async () => {
    await sendPurchaseOrderEmail("user@x.test", "Alice", poData({
      paymentStatus: "success",
      registrationFailed: true,
    }));
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Payment received, but registration failed — purchase order PO_123"
    );
  });

  it("payment success + registration OK → 'Payment received — purchase order' subject", async () => {
    await sendPurchaseOrderEmail("user@x.test", "Alice", poData({
      paymentStatus: "success",
      registrationFailed: false,
    }));
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Payment received — purchase order PO_123"
    );
  });

  it("payment FAILED → 'didn’t go through' subject", async () => {
    await sendPurchaseOrderEmail("user@x.test", "Alice", poData({
      paymentStatus: "failed",
    }));
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Your payment didn't go through — purchase order PO_123"
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
  it("ALL successful (no pending) → 'Your order is confirmed — invoice INV'", async () => {
    await sendOrderConfirmationEmail(
      "user@x.test",
      "Alice",
      ocData(
        [{ domainName: "x.com", price: 500, registrationPeriod: 1 }],
        [{ domainName: "x.com", price: 500, registrationPeriod: 1, status: "registered" }]
      )
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Your order is confirmed — invoice INV-1"
    );
  });

  it("all pending (only-pending-or-successful) → 'Payment received — invoice INV'", async () => {
    await sendOrderConfirmationEmail(
      "user@x.test",
      "Alice",
      ocData(
        [],
        [{ domainName: "x.com", price: 500, registrationPeriod: 1, status: "pending" }]
      )
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Payment received — invoice INV-1"
    );
  });

  it("BOTH successful + pending → 'Payment received — invoice INV'", async () => {
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
      "Payment received — invoice INV-1"
    );
  });

  it("a mix that includes 'failed' → fallback 'looking into your order' subject", async () => {
    await sendOrderConfirmationEmail(
      "user@x.test",
      "Alice",
      ocData(
        [],
        [{ domainName: "x.com", price: 500, registrationPeriod: 1, status: "failed" }]
      )
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Payment received — we're looking into your order, invoice INV-1"
    );
  });
});

describe("customer order emails — the ResellerOS plain pattern", () => {
  beforeEach(() => {
    vi.stubEnv("FROM_NAME", "Anutech Digital");
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.com/");
  });

  const sent = (i = 0) =>
    sendEmailMock.mock.calls[i][0] as { to: string; subject: string; text: string; html: string };

  it("both emails: 'Hi <first name>,', support address, signed by the brand, no banners/tables/emoji", async () => {
    await sendPurchaseOrderEmail("ada@x.test", "Ada Lovelace", poData({ registrationFailed: true }));
    await sendPurchaseOrderEmail("ada@x.test", "Ada Lovelace", poData({ paymentStatus: "failed" }));
    await sendOrderConfirmationEmail(
      "ada@x.test",
      "Ada Lovelace",
      ocData(
        [{ domainName: "x.com", price: 500, registrationPeriod: 1 }],
        [
          { domainName: "x.com", price: 500, registrationPeriod: 1, status: "registered" },
          { domainName: "y.com", price: 500, registrationPeriod: 1, status: "failed" },
        ]
      )
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(3);
    for (const [m] of sendEmailMock.mock.calls) {
      expect(m.text).toMatch(/^Hi Ada,\n/);
      expect(m.text).toMatch(/— Anutech Digital$/);
      expect(m.text).toContain("Questions? Reply to this email or write to support@anutech.in.");
      expect(m.html).toContain('href="mailto:support@anutech.in"');
      expect(m.html).not.toMatch(/gradient|<table|<h1|<h3/i);
      expect(`${m.subject}\n${m.text}`).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(m.text).not.toMatch(/Private Limited|Domain Management|do not reply/i);
    }
  });

  it("purchase order: every fact the old email showed, as text lines", async () => {
    await sendPurchaseOrderEmail(
      "ada@x.test",
      "Ada",
      poData({
        amount: 1416,
        subtotal: 1200,
        domains: [
          { domainName: "x.com", price: 500, registrationPeriod: 2 },
          { domainName: "x.com", price: 200, registrationPeriod: 1, itemType: "hosting", planName: "Starter" },
        ],
      })
    );
    const { text } = sent();
    expect(text).toContain("  x.com — 2 years at ₹500.00/year — ₹1000.00");
    expect(text).toContain("  x.com (Starter) — 1 year at ₹200.00/year — ₹200.00");
    expect(text).toContain("  Subtotal: ₹1200.00");
    expect(text).toContain("  GST (18%): ₹216.00");
    expect(text).toContain("  Total: ₹1416.00 INR (GST included)");
    expect(text).toContain("  Purchase order: PO_123");
    expect(text).toContain("  Order ID: ORD_42");
    expect(text).toContain("  Invoice number: INV-1");
    expect(text).toContain("  Payment: successful");
    expect(text).toContain("  Payment ID: pay_xyz");
    expect(text).toContain("  Date: 2026-06-01T00:00:00.000Z");
  });

  it("purchase order: registration failed promises the 2-10 day refund; payment failed hides the payment id", async () => {
    await sendPurchaseOrderEmail("ada@x.test", "Ada", poData({ registrationFailed: true }));
    expect(sent(0).text).toContain("refund to your original payment method will be initiated within 2-10 business days");
    await sendPurchaseOrderEmail("ada@x.test", "Ada", poData({ paymentStatus: "failed" }));
    expect(sent(1).text).toContain("  Payment: failed");
    expect(sent(1).text).not.toContain("pay_xyz");
  });

  it("order confirmation: lines with status, 18% GST split, ids, and the dashboard link", async () => {
    await sendOrderConfirmationEmail(
      "ada@x.test",
      "Ada",
      ocData(
        [{ domainName: "x.com", price: 500, registrationPeriod: 1 }],
        [
          { domainName: "x.com", price: 500, registrationPeriod: 1, status: "registered" },
          { domainName: "y.com", price: 250, registrationPeriod: 2, status: "pending" },
        ]
      )
    );
    const { text, html } = sent();
    expect(text).toContain("1 domain(s) registered successfully.");
    expect(text).toContain("  x.com — 1 year at ₹500.00 — ₹500.00 — registered");
    expect(text).toContain("  y.com — 2 years at ₹250.00 — ₹500.00 — processing");
    expect(text).toContain("  Subtotal: ₹847.46");
    expect(text).toContain("  GST (18%): ₹152.54");
    expect(text).toContain("  Total: ₹1000.00 INR (GST included)");
    expect(text).toContain("  Purchase order: PO_123");
    expect(text).toContain("  Order ID: ORD_42");
    expect(text).toContain("  Invoice number: INV-1");
    expect(text).toContain("  Payment ID: pay_xyz");
    expect(text).toContain("  Order date: 2026-06-01T00:00:00.000Z");
    expect(text).toContain("  https://app.example.com/dashboard\n");
    expect(html).toContain('<a href="https://app.example.com/dashboard">');
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
