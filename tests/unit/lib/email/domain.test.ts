/**
 * Tests for `@/lib/email/domain` (rescan-4 slice 7em).
 * Domain-flow email templates. Pins the subject contracts that drive
 * inbox-preview UX:
 *  - sendDomainPurchaseEmail: 'Domain Purchase Confirmation'
 *  - sendDomainRegistrationEmail: 'Domain Registration Successful'
 *  - sendDomainRegistrationFailureEmail: 'Domain Registration Issue'
 *  - sendRenewalInvoiceEmail: 'Hosting Renewal Reminder - {domain}'
 *  - sendDomainBookingStatusEmail: 'Domain Booking Status Notification'
 *  - **sendServiceReminderEmail subject ternary on daysRemaining**:
 *    daysRemaining<=1 → 🚨 URGENT prefix; else → 'Renewal Reminder: ...'
 *    with pluralised days (1 day vs N days)
 *  - sendServiceExpiryTodayEmail subject embeds serviceType + serviceName
 *  - sendServiceSuspensionEmail: 'Account Suspended: {name}'
 *  - sendServiceGracePeriodEmail subject embeds the grace-end date
 *  - **sendDomainAvailableEmail subject 'Good news! {domain} is now
 *    available'** (this is the domain-watch fire-and-notify cron's
 *    email — different prefix to stand out in inbox)
 *  - All template fns route through sendEmail + propagate its return
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmailMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("@/lib/email/transporter", () => ({
  sendEmail: sendEmailMock,
  SUPPORT_EMAIL: "support@anutech.in",
}));

// The non-essential senders (reminder / expiry / grace / domain-available)
// route through the notification helper (opt-out + unsubscribe footer). Stub
// its deps so these template tests still exercise the real builder → sendEmail.
vi.mock("@/lib/services/users", () => ({
  getUserByEmail: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/unsubscribe-token", () => ({
  unsubscribeUrl: () => "https://app.test/api/notifications/unsubscribe?token=T",
}));
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/dateUtils", () => ({
  formatIndianDateTime: (d: Date) => d.toISOString(),
  formatIndianDateTimeLong: (d: Date) => d.toISOString(),
  formatIndianDate: (d: Date) => d.toISOString().split("T")[0],
}));

import {
  sendDomainPurchaseEmail,
  sendDomainRegistrationEmail,
  sendDomainRegistrationFailureEmail,
  sendRenewalInvoiceEmail,
  sendDomainBookingStatusEmail,
  sendServiceReminderEmail,
  sendServiceExpiryTodayEmail,
  sendServiceSuspensionEmail,
  sendServiceGracePeriodEmail,
  sendDomainAvailableEmail,
} from "@/lib/email/domain";

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(true);
});

describe("simple-subject templates", () => {
  it("sendDomainPurchaseEmail: 'Domain Purchase Confirmation'", async () => {
    await sendDomainPurchaseEmail(
      "user@x.test",
      "Alice",
      [{ domainName: "x.com", price: 500, status: "registered" }],
      500
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Domain Purchase Confirmation"
    );
    expect(sendEmailMock.mock.calls[0][0].to).toBe("user@x.test");
  });

  it("sendDomainRegistrationEmail: 'Domain Registration Successful'", async () => {
    await sendDomainRegistrationEmail(
      "user@x.test",
      "Alice",
      [{ domainName: "x.com", expiresAt: new Date("2027-01-01") }]
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Domain Registration Successful"
    );
  });

  it("sendDomainRegistrationFailureEmail: 'Domain Registration Issue'", async () => {
    await sendDomainRegistrationFailureEmail(
      "user@x.test",
      "Alice",
      [{ domainName: "x.com", error: "DNS error" }]
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Domain Registration Issue"
    );
  });

  it("sendDomainBookingStatusEmail: fixed subject", async () => {
    await sendDomainBookingStatusEmail(
      "user@x.test",
      "Alice",
      [
        {
          domainName: "x.com",
          status: "registered",
          registrationPeriod: 1,
          expiresAt: new Date("2027-01-01"),
        },
      ],
      "ORD_42"
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Domain Booking Status Notification"
    );
  });
});

describe("sendRenewalInvoiceEmail", () => {
  it("subject embeds the domain name", async () => {
    await sendRenewalInvoiceEmail(
      "user@x.test",
      "Alice",
      {
        domainName: "myhost.com",
        invoiceNumber: "INV-1",
        dueDate: new Date("2027-01-01"),
        invoiceAmount: 500,
      }
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Hosting Renewal Reminder - myhost.com"
    );
  });
});

describe("sendServiceReminderEmail — urgency-tiered subject", () => {
  it("daysRemaining=0 → 🚨 URGENT 'expires TODAY' subject", async () => {
    await sendServiceReminderEmail("user@x.test", {
      serviceName: "x.com",
      serviceType: "hosting",
      daysRemaining: 0,
      amount: 500,
      currency: "INR",
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(
      /🚨.*URGENT.*hosting.*x\.com.*TODAY/
    );
  });

  it("daysRemaining=1 → ALSO 🚨 URGENT (boundary edge)", async () => {
    await sendServiceReminderEmail("user@x.test", {
      serviceName: "x.com",
      serviceType: "domain",
      daysRemaining: 1,
      amount: 500,
      currency: "INR",
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/🚨.*URGENT/);
  });

  it("daysRemaining=7 → 'Renewal Reminder' subject with '7 days' (plural)", async () => {
    await sendServiceReminderEmail("user@x.test", {
      serviceName: "x.com",
      serviceType: "domain",
      daysRemaining: 7,
      amount: 500,
      currency: "INR",
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Renewal Reminder: x.com expires in 7 days"
    );
  });

  it("daysRemaining=2 → 'expires in 2 days' (plural)", async () => {
    await sendServiceReminderEmail("user@x.test", {
      serviceName: "x.com",
      serviceType: "domain",
      daysRemaining: 2,
      amount: 0,
      currency: "INR",
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Renewal Reminder: x.com expires in 2 days"
    );
  });
});

describe("sendServiceExpiryTodayEmail", () => {
  it("subject embeds serviceType + serviceName + TODAY", async () => {
    await sendServiceExpiryTodayEmail("user@x.test", {
      serviceName: "myhost.com",
      serviceType: "hosting",
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(
      /🚨.*URGENT.*hosting.*myhost\.com.*TODAY/
    );
  });
});

describe("sendServiceSuspensionEmail", () => {
  it("subject 'Account Suspended: {name}'", async () => {
    await sendServiceSuspensionEmail("user@x.test", {
      serviceName: "x.com",
      serviceType: "hosting",
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Account Suspended: x.com"
    );
  });

  it("renders the service name + type in the body", async () => {
    await sendServiceSuspensionEmail("user@x.test", {
      serviceName: "example.com",
      serviceType: "Hosting",
    });
    const html = sendEmailMock.mock.calls[0][0].html;
    expect(html).toContain("example.com");
    expect(html).toContain("Hosting");
  });

  // Tokens-flow recovery-path callout (d4b6a64 + this commit). When
  // the hard 1-attempt MIT rule trips a suspension, the customer needs
  // a clear re-subscribe CTA — generic "contact support" wording isn't
  // enough because the mandate is dead and can't be retried.
  describe("mandateMode='tokens' recovery block", () => {
    it("renders the Tokens-flow recovery copy + re-subscribe CTA", async () => {
      await sendServiceSuspensionEmail("user@x.test", {
        serviceName: "example.com",
        serviceType: "Hosting",
        mandateMode: "tokens",
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).toMatch(/What happened/i);
      expect(html).toMatch(/each recurring charge is attempted once/i);
      expect(html).toMatch(/How to restore service/i);
      expect(html).toMatch(/re-subscribe with a fresh card or UPI ID/i);
      expect(html).toContain("Restore Service");
      // Common-cause hints help the customer self-diagnose
      expect(html).toMatch(/card expired or replaced/i);
      expect(html).toMatch(/UPI mandate that was revoked/i);
    });

    it("mandateMode unset → generic contact-support copy (back-compat for legacy callers)", async () => {
      await sendServiceSuspensionEmail("user@x.test", {
        serviceName: "example.com",
        serviceType: "Hosting",
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).not.toMatch(/What happened/i);
      expect(html).not.toMatch(/re-subscribe/i);
      expect(html).toMatch(/Please contact support/i);
      expect(html).toContain("Open Dashboard");
    });

    it("mandateMode='subscriptions' → generic copy (Razorpay handles their retries server-side)", async () => {
      await sendServiceSuspensionEmail("user@x.test", {
        serviceName: "example.com",
        serviceType: "Hosting",
        mandateMode: "subscriptions",
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).not.toMatch(/each recurring charge is attempted once/i);
      expect(html).toMatch(/Please contact support/i);
    });

    it("mandateMode='manual' → generic copy (no auto-renewal at all)", async () => {
      await sendServiceSuspensionEmail("user@x.test", {
        serviceName: "example.com",
        serviceType: "Hosting",
        mandateMode: "manual",
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).not.toMatch(/each recurring charge is attempted once/i);
      expect(html).toMatch(/Please contact support/i);
    });
  });
});

describe("sendServiceGracePeriodEmail", () => {
  it("subject embeds 'Renew {name} before {date}'", async () => {
    await sendServiceGracePeriodEmail("user@x.test", {
      serviceName: "x.com",
      serviceType: "hosting",
      graceDays: 7,
      graceEndsAt: new Date("2027-01-15"),
    });
    const subj = sendEmailMock.mock.calls[0][0].subject;
    expect(subj).toMatch(/Grace Period Active.*x\.com/);
    // toLocaleDateString('en-IN', ...) renders as e.g. '15 January 2027'.
    expect(subj).toMatch(/January 2027/);
  });
});

describe("sendDomainAvailableEmail", () => {
  it("subject 'Good news! {domain} is now available' (domain-watch cron format)", async () => {
    // signature is (userEmail, domainName, userName?) — userName is THIRD,
    // not second (different from the other email fns)
    await sendDomainAvailableEmail("user@x.test", "wanted.com", "Alice");
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Good news! wanted.com is now available"
    );
  });

  it("propagates sendEmail return (false → false)", async () => {
    sendEmailMock.mockResolvedValueOnce(false);
    expect(
      await sendDomainAvailableEmail("user@x.test", "wanted.com", "Alice")
    ).toBe(false);
  });
});
