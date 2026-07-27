/**
 * Tests for `@/lib/services/payment/post-tasks` (rescan-4 slice 7ej).
 * Zoho-invoice creation + fire-and-forget post-payment side-effects. Pins:
 *  - createZohoInvoice: **2-attempt outer retry by default with 1.5s
 *    spacer between** (handles cold-start + short Zoho hiccups so the
 *    user's first payment usually lands without background self-heal);
 *    custom maxAttempts + retryDelayMs honoured
 *  - On final failure throws the LAST error (not a wrapped one) — caller
 *    surfaces to the user
 *  - **Claim contention**: claimOrderForZohoInvoice returns null → returns
 *    `{invoiceId:"", invoiceNumber:null}` WITHOUT calling zohoService
 *    (another worker is already creating it)
 *  - **Failure releases the claim**: zohoService.createInvoice throw →
 *    releaseZohoInvoiceClaim called BEFORE rethrow (so the next retry
 *    or worker can re-claim)
 *  - **No-invoice-id sentinel release**: createInvoice resolves but
 *    invoice.invoice_id missing → release + throw with the 'possible
 *    validation error' message (caller can surface the GST hint)
 *  - createInvoice success → recordZohoInvoiceForOrder(invoice_id,
 *    invoice_number) before returning
 *  - runPostPaymentTasks fires admin notification + domain-booking
 *    email in parallel; **both errors caught internally** — caller's
 *    payment response is NEVER blocked by a transient email failure
 *  - domain-booking email only sent for itemType != 'hosting' items;
 *    hosting-only order → no domain email fired
 *  - ADMIN_EMAIL env defaults to 'sales@anutech.in' when missing
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const claimOrder = vi.hoisted(() => vi.fn());
const recordInvoice = vi.hoisted(() => vi.fn());
const releaseClaim = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  claimOrderForZohoInvoice: claimOrder,
  recordZohoInvoiceForOrder: recordInvoice,
  releaseZohoInvoiceClaim: releaseClaim,
}));

const createInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: { getInstance: () => ({ createInvoice }) },
}));

const sendAdminNotification = vi.hoisted(() => vi.fn());
const sendDomainBookingStatusEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: {
    sendAdminNotification,
    sendDomainBookingStatusEmail,
  },
}));

const inferPeriodUnit = vi.hoisted(() => vi.fn((item: { itemType?: string }) =>
  item.itemType === "hosting" ? "months" : "years"
));
vi.mock("@/lib/billing", () => ({ inferPeriodUnit }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createZohoInvoice, runPostPaymentTasks } from "@/lib/services/payment/post-tasks";

beforeEach(() => {
  claimOrder.mockReset();
  recordInvoice.mockReset();
  releaseClaim.mockReset();
  createInvoice.mockReset();
  sendAdminNotification.mockReset();
  sendDomainBookingStatusEmail.mockReset();
  inferPeriodUnit.mockClear();
});

const ZOHO_CTX = {
  // amount>0 + non-trial orderType so the zero-amount/trial guard passes and
  // these tests exercise the actual invoice-creation + retry behavior.
  order: { _id: "ORDER_DOC_ID", orderId: "ORD_42", amount: 50000, orderType: "domain" } as never,
  orderId: "ORD_42",
  razorpay_payment_id: "pay_xyz",
  paymentDetails: { amount: 50000 } as never,
  user: { firstName: "Alice", lastName: "Smith", email: "a@x.test" } as never,
  cartItems: [{ itemType: "domain", domainName: "example.com" }] as never,
};

describe("createZohoInvoice — happy path", () => {
  it("claims order → calls zohoService.createInvoice → records invoice → returns the id pair", async () => {
    claimOrder.mockResolvedValueOnce({ _id: "ORDER_DOC_ID" });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "INV_1",
      invoice_number: "INV-001",
    });
    const result = await createZohoInvoice(ZOHO_CTX);
    expect(claimOrder).toHaveBeenCalledWith("ORDER_DOC_ID");
    expect(createInvoice).toHaveBeenCalled();
    expect(recordInvoice).toHaveBeenCalledWith("ORDER_DOC_ID", {
      invoiceId: "INV_1",
      invoiceNumber: "INV-001",
    });
    expect(result).toEqual({ invoiceId: "INV_1", invoiceNumber: "INV-001" });
  });

  it("cartItems are mapped through inferPeriodUnit before going to Zoho", async () => {
    claimOrder.mockResolvedValueOnce({ _id: "ORDER_DOC_ID" });
    createInvoice.mockResolvedValueOnce({ invoice_id: "INV_1" });
    await createZohoInvoice({
      ...ZOHO_CTX,
      cartItems: [
        { itemType: "domain", domainName: "x.com" } as never,
        { itemType: "hosting", domainName: "hosting-1" } as never,
      ],
    });
    expect(inferPeriodUnit).toHaveBeenCalledTimes(2);
  });

  it("no invoice_number → records with undefined + returns null invoiceNumber", async () => {
    claimOrder.mockResolvedValueOnce({ _id: "ORDER_DOC_ID" });
    createInvoice.mockResolvedValueOnce({ invoice_id: "INV_1" });
    const result = await createZohoInvoice(ZOHO_CTX);
    expect(result.invoiceNumber).toBeNull();
    expect(recordInvoice).toHaveBeenCalledWith("ORDER_DOC_ID", {
      invoiceId: "INV_1",
      invoiceNumber: undefined,
    });
  });
});

describe("createZohoInvoice — claim contention", () => {
  it("claim returns null → returns {invoiceId:'', invoiceNumber:null} WITHOUT calling zoho", async () => {
    claimOrder.mockResolvedValueOnce(null);
    const result = await createZohoInvoice(ZOHO_CTX);
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null });
    expect(createInvoice).not.toHaveBeenCalled();
    expect(releaseClaim).not.toHaveBeenCalled();
  });
});

describe("createZohoInvoice — failure paths release the claim", () => {
  it("zohoService.createInvoice throw → releaseClaim BEFORE rethrow", async () => {
    claimOrder.mockResolvedValue({ _id: "ORDER_DOC_ID" });
    createInvoice.mockRejectedValue(new Error("token expired"));
    await expect(
      createZohoInvoice(ZOHO_CTX, { maxAttempts: 1 })
    ).rejects.toThrow("token expired");
    expect(releaseClaim).toHaveBeenCalledWith("ORDER_DOC_ID");
  });

  it("missing invoice_id → releaseClaim + throw with 'possible validation error' message", async () => {
    claimOrder.mockResolvedValueOnce({ _id: "ORDER_DOC_ID" });
    createInvoice.mockResolvedValueOnce({ invoice_id: null });
    await expect(
      createZohoInvoice(ZOHO_CTX, { maxAttempts: 1 })
    ).rejects.toThrow(/no invoice_id|validation error/i);
    expect(releaseClaim).toHaveBeenCalledWith("ORDER_DOC_ID");
  });
});

describe("createZohoInvoice — outer retry", () => {
  it("default 2 attempts: first fails, second succeeds → returns success", async () => {
    claimOrder.mockResolvedValue({ _id: "ORDER_DOC_ID" });
    createInvoice
      .mockRejectedValueOnce(new Error("first try blip"))
      .mockResolvedValueOnce({ invoice_id: "INV_1", invoice_number: "INV-1" });
    const result = await createZohoInvoice(ZOHO_CTX, {
      maxAttempts: 2,
      retryDelayMs: 0, // skip the sleep
    });
    expect(result.invoiceId).toBe("INV_1");
    expect(createInvoice).toHaveBeenCalledTimes(2);
  });

  it("both attempts fail → throws the LAST error (not the first)", async () => {
    claimOrder.mockResolvedValue({ _id: "ORDER_DOC_ID" });
    createInvoice
      .mockRejectedValueOnce(new Error("first error"))
      .mockRejectedValueOnce(new Error("second error"));
    await expect(
      createZohoInvoice(ZOHO_CTX, { maxAttempts: 2, retryDelayMs: 0 })
    ).rejects.toThrow("second error");
  });

  it("maxAttempts=1 → no retry, single failure surfaces immediately", async () => {
    claimOrder.mockResolvedValue({ _id: "ORDER_DOC_ID" });
    createInvoice.mockRejectedValueOnce(new Error("one-shot fail"));
    await expect(
      createZohoInvoice(ZOHO_CTX, { maxAttempts: 1, retryDelayMs: 0 })
    ).rejects.toThrow("one-shot fail");
    expect(createInvoice).toHaveBeenCalledTimes(1);
  });
});

describe("runPostPaymentTasks", () => {
  const POST_CTX = {
    order: {
      orderId: "ORD_42",
      invoiceNumber: "INV-001",
      amount: 1000,
      currency: "INR",
    } as never,
    user: {
      firstName: "Alice",
      lastName: "Smith",
      email: "a@x.test",
    } as never,
    orderDomains: [
      { itemType: "domain", domainName: "x.com", status: "registered", registrationPeriod: 1, expiresAt: new Date("2027-01-01") },
      { itemType: "hosting", domainName: "hosting-1", status: "active", registrationPeriod: 12, expiresAt: new Date("2027-01-01") },
    ] as never,
    finalSuccessfulDomains: ["x.com"],
    orderStatus: "completed",
  };

  it("fires admin notification + domain-booking email in PARALLEL", async () => {
    sendAdminNotification.mockResolvedValueOnce(undefined);
    sendDomainBookingStatusEmail.mockResolvedValueOnce(undefined);
    await runPostPaymentTasks(POST_CTX);
    expect(sendAdminNotification).toHaveBeenCalled();
    expect(sendDomainBookingStatusEmail).toHaveBeenCalled();
  });

  it("admin-notify throw is SWALLOWED — runPostPaymentTasks still resolves", async () => {
    sendAdminNotification.mockRejectedValueOnce(new Error("SMTP down"));
    sendDomainBookingStatusEmail.mockResolvedValueOnce(undefined);
    await expect(runPostPaymentTasks(POST_CTX)).resolves.toBeUndefined();
  });

  it("domain-booking email throw is ALSO swallowed", async () => {
    sendAdminNotification.mockResolvedValueOnce(undefined);
    sendDomainBookingStatusEmail.mockRejectedValueOnce(new Error("template error"));
    await expect(runPostPaymentTasks(POST_CTX)).resolves.toBeUndefined();
  });

  it("hosting-only order (no domain items) → domain-booking email NOT fired", async () => {
    sendAdminNotification.mockResolvedValueOnce(undefined);
    await runPostPaymentTasks({
      ...POST_CTX,
      orderDomains: [
        { itemType: "hosting", domainName: "h1", status: "active", registrationPeriod: 12, expiresAt: new Date() },
      ] as never,
    });
    expect(sendDomainBookingStatusEmail).not.toHaveBeenCalled();
    expect(sendAdminNotification).toHaveBeenCalled();
  });

  it("admin notification uses ADMIN_EMAIL env, falls back to 'sales@anutech.in'", async () => {
    const ORIG = process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_EMAIL;
    sendAdminNotification.mockResolvedValueOnce(undefined);
    await runPostPaymentTasks(POST_CTX);
    expect(sendAdminNotification).toHaveBeenCalledWith(
      "sales@anutech.in",
      expect.any(String),
      expect.any(String),
      expect.any(Object)
    );
    process.env.ADMIN_EMAIL = ORIG;
  });
});
