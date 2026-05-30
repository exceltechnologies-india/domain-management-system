/**
 * Tests for `@/lib/email` index barrel (rescan-4 slice 7dn).
 * Backwards-compat shim that exposes a class-style EmailService re-
 * exporting all the per-topic email functions. Pins the contract:
 * every documented send* function exists as a static method.
 */
import { describe, it, expect } from "vitest";

vi.hoisted(() => {
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "noreply@example.com";
  process.env.SMTP_PASS = "secret";
  process.env.FROM_EMAIL = "noreply@example.com";
  process.env.FROM_NAME = "Anutech";
});

import { EmailService, sendEmail } from "@/lib/email";
import { vi } from "vitest";

describe("EmailService class shim", () => {
  it("re-exports sendEmail at module top-level + as a static", () => {
    expect(typeof sendEmail).toBe("function");
    expect(EmailService.sendEmail).toBe(sendEmail);
  });

  it.each([
    "sendWelcomeEmail",
    "sendPasswordResetEmail",
    "sendPasswordResetNotificationEmail",
    "sendPasswordChangeNotificationEmail",
    "sendProfileUpdateEmail",
    "sendProfileCompletionEmail",
    "sendActivationEmail",
  ])("exposes auth helper %s as a static", (name) => {
    expect(typeof (EmailService as unknown as Record<string, unknown>)[name]).toBe("function");
  });

  it.each([
    "sendPurchaseOrderEmail",
    "sendOrderConfirmationEmail",
    "sendAdminNotification",
    "sendLowBalanceAlert",
  ])("exposes billing helper %s as a static", (name) => {
    expect(typeof (EmailService as unknown as Record<string, unknown>)[name]).toBe("function");
  });

  it.each([
    "sendDomainPurchaseEmail",
    "sendDomainRegistrationEmail",
    "sendDomainRegistrationFailureEmail",
    "sendRenewalInvoiceEmail",
    "sendDomainBookingStatusEmail",
    "sendServiceReminderEmail",
    "sendServiceExpiryTodayEmail",
    "sendServiceSuspensionEmail",
    "sendServiceGracePeriodEmail",
    "sendDomainAvailableEmail",
  ])("exposes domain helper %s as a static", (name) => {
    expect(typeof (EmailService as unknown as Record<string, unknown>)[name]).toBe("function");
  });

  it("exposes the hosting helper sendHostingProvisionedEmail as a static", () => {
    expect(typeof EmailService.sendHostingProvisionedEmail).toBe("function");
  });
});
