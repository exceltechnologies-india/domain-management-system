/**
 * Tests for `@/lib/services/payment/post-tasks` (rescan-4 slice 7ej).
 * Fire-and-forget post-payment side-effects. Pins:
 *  - runPostPaymentTasks fires admin notification + domain-booking
 *    email in parallel; **both errors caught internally** — caller's
 *    payment response is NEVER blocked by a transient email failure
 *  - domain-booking email only sent for itemType != 'hosting' items;
 *    hosting-only order → no domain email fired
 *  - ADMIN_EMAIL env defaults to 'sales@anutech.in' when missing
 *
 * Invoice creation no longer lives here: `createZohoInvoice` was removed with
 * Zoho Books on 24 Sep 2026, and the only issuer is
 * lib/services/billing/createPrimaryInvoice.ts (tested on its own).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendAdminNotification = vi.hoisted(() => vi.fn());
const sendDomainBookingStatusEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: {
    sendAdminNotification,
    sendDomainBookingStatusEmail,
  },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import * as postTasks from "@/lib/services/payment/post-tasks";
import { runPostPaymentTasks } from "@/lib/services/payment/post-tasks";

beforeEach(() => {
  sendAdminNotification.mockReset();
  sendDomainBookingStatusEmail.mockReset();
});

describe("module surface", () => {
  it("exports runPostPaymentTasks and no second invoice issuer", () => {
    expect(typeof postTasks.runPostPaymentTasks).toBe("function");
    expect(Object.keys(postTasks)).not.toContain("createZohoInvoice");
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
