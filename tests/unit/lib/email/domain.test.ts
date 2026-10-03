/**
 * Tests for `@/lib/email/domain` (rescan-4 slice 7em).
 * Domain-flow email templates. Pins the subject contracts that drive
 * inbox-preview UX:
 *  - sendDomainPurchaseEmail: 'Domain Purchase Confirmation'
 *  - sendDomainRegistrationEmail: 'Domain Registration Successful'
 *  - sendDomainRegistrationFailureEmail: 'Domain Registration Issue'
 *  - sendDomainBookingStatusEmail: 'Domain Booking Status Notification'
 *  - **sendServiceReminderEmail subject ternary on daysRemaining**:
 *    daysRemaining<=1 → URGENT prefix (no emoji since 3 Oct 2026); else → 'Renewal Reminder: ...'
 *    with pluralised days (1 day vs N days)
 *  - sendServiceExpiryTodayEmail subject embeds serviceType + serviceName
 *  - sendServiceSuspensionEmail: 'Account Suspended: {name}'
 *  - sendServiceGracePeriodEmail subject embeds the grace-end date
 *  - **sendDomainAvailableEmail subject 'Good news! {domain} is now
 *    available'** (this is the domain-watch fire-and-notify cron's
 *    email — different prefix to stand out in inbox)
 *  - All template fns route through sendEmail + propagate its return
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

describe("sendServiceReminderEmail — urgency-tiered subject", () => {
  it("daysRemaining=0 → 'URGENT … expires TODAY' subject, no emoji", async () => {
    await sendServiceReminderEmail("user@x.test", {
      serviceName: "x.com",
      serviceType: "hosting",
      daysRemaining: 0,
      renewal: { kind: "preparing" },
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "URGENT: Your hosting x.com expires TODAY"
    );
    expect(String(sendEmailMock.mock.calls[0][0].text)).toMatch(/hosting x\.com expires today/);
  });

  it("daysRemaining=1 → ALSO URGENT (boundary edge)", async () => {
    await sendServiceReminderEmail("user@x.test", {
      serviceName: "x.com",
      serviceType: "domain",
      daysRemaining: 1,
      renewal: { kind: "preparing" },
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/^URGENT/);
    expect(String(sendEmailMock.mock.calls[0][0].text)).toMatch(/expires in 1 day and needs your action now/);
  });

  it("body lists service, type and days remaining as plain lines", async () => {
    await sendServiceReminderEmail("user@x.test", {
      serviceName: "x.com",
      serviceType: "domain",
      daysRemaining: 7,
      renewal: { kind: "preparing" },
    });
    const text = String(sendEmailMock.mock.calls[0][0].text);
    expect(text).toMatch(/will expire in 7 days\. Renew before then to avoid service interruption\./);
    expect(text).toContain("  Service: x.com\n  Type: domain\n  Days remaining: 7 days");
  });

  it("daysRemaining=7 → 'Renewal Reminder' subject with '7 days' (plural)", async () => {
    await sendServiceReminderEmail("user@x.test", {
      serviceName: "x.com",
      serviceType: "domain",
      daysRemaining: 7,
      renewal: { kind: "preparing" },
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
      renewal: { kind: "preparing" },
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Renewal Reminder: x.com expires in 2 days"
    );
  });
});

describe("sendServiceReminderEmail — the renewal block (owner, 26 Sep 2026: no DMS price)", () => {
  const base = { serviceName: "x.com", serviceType: "hosting", daysRemaining: 7 } as const;
  const html = () => String(sendEmailMock.mock.calls[0][0].html);

  const text = () => String(sendEmailMock.mock.calls[0][0].text);

  it("pay → a link to ResellerOS's payment_url, and no rupee figure anywhere", async () => {
    await sendServiceReminderEmail("u@x.test", { ...base, renewal: { kind: "pay", paymentUrl: "https://ros.test/quote/Q-1/accept?t=a&b" } });
    expect(text()).toContain("View and pay it here:\n  https://ros.test/quote/Q-1/accept?t=a&b");
    expect(html()).toContain('href="https://ros.test/quote/Q-1/accept?t=a&amp;b"');
    expect(text()).toMatch(/Your renewal bill is ready/);
    expect(html()).not.toMatch(/₹|Renewal Amount/);
  });

  it("choose → says how many bills, links the Invoices page", async () => {
    await sendServiceReminderEmail("u@x.test", { ...base, renewal: { kind: "choose", count: 2, invoicesUrl: "https://dms.test/dashboard/invoices" } });
    expect(text()).toMatch(/You have 2 bills waiting for payment/);
    expect(text()).toContain("renewal bill for x.com:\n  https://dms.test/dashboard/invoices");
    expect(html()).toContain('href="https://dms.test/dashboard/invoices"');
  });

  it("preparing → the bill is being prepared and will be emailed; no pay link", async () => {
    await sendServiceReminderEmail("u@x.test", { ...base, renewal: { kind: "preparing" } });
    expect(text()).toMatch(/renewal bill is being prepared/);
    // The only link is the unsubscribe line lib/email/notifications.ts adds after the sign-off.
    expect(text().replace(/\n\nDon't want these emails\? Unsubscribe: \S+$/, "")).not.toMatch(/https?:\/\//);
  });

  it("unknown → still sent, says where the bill comes from, no link and no price", async () => {
    await sendServiceReminderEmail("u@x.test", { ...base, renewal: { kind: "unknown" } });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/comes from our billing system and is emailed to you/);
    expect(html()).not.toMatch(/₹|View and pay/);
  });
});

describe("sendServiceExpiryTodayEmail", () => {
  it("subject embeds serviceType + serviceName + TODAY", async () => {
    await sendServiceExpiryTodayEmail("user@x.test", {
      serviceName: "myhost.com",
      serviceType: "hosting",
    });
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "URGENT: Your hosting myhost.com expires TODAY"
    );
  });

  it("says it will be suspended if not renewed, with the hosting renew link", async () => {
    await sendServiceExpiryTodayEmail("user@x.test", {
      serviceName: "myhost.com",
      serviceType: "hosting",
    });
    const text = String(sendEmailMock.mock.calls[0][0].text);
    expect(text).toMatch(/hosting myhost\.com expires today\. If it is not renewed, it will be suspended automatically\./);
    expect(text).toMatch(/\n {2}\S*\/dashboard\/hosting\n/);
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
      const text = sendEmailMock.mock.calls[0][0].text;
      expect(text).toMatch(/What happened/i);
      expect(text).toMatch(/each recurring charge is attempted once/i);
      expect(text).toMatch(/How to restore service/i);
      expect(text).toMatch(/re-subscribe with a fresh card or UPI ID/i);
      expect(text).toMatch(/reactivated as soon as the first charge succeeds\.\n {2}\S*\/dashboard\/hosting/);
      // Common-cause hints help the customer self-diagnose
      expect(text).toMatch(/card expired or replaced/i);
      expect(text).toMatch(/UPI mandate that was revoked/i);
    });

    it("mandateMode unset → generic contact-support copy (back-compat for legacy callers)", async () => {
      await sendServiceSuspensionEmail("user@x.test", {
        serviceName: "example.com",
        serviceType: "Hosting",
      });
      const text = sendEmailMock.mock.calls[0][0].text;
      expect(text).not.toMatch(/What happened/i);
      expect(text).not.toMatch(/re-subscribe/i);
      expect(text).toMatch(/Please contact support/i);
      expect(text).toMatch(/Your dashboard:\n {2}\S*\/dashboard\/hosting/);
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

describe("the facts each plain email still states", () => {
  const text = () => String(sendEmailMock.mock.calls[0][0].text);

  it("purchase: each domain with price and status, and the total", async () => {
    await sendDomainPurchaseEmail("u@x.test", "Alice Smith", [
      { domainName: "a.com", price: 799, status: "registered" },
      { domainName: "b.in", price: 499, status: "pending" },
    ], 1298);
    expect(text()).toContain("  a.com — ₹799 (registered)\n  b.in — ₹499 (pending)\n  Total: ₹1298");
    expect(text()).toMatch(/\/dashboard\n/);
  });

  it("registration: each domain with its expiry date and the DNS management link", async () => {
    await sendDomainRegistrationEmail("u@x.test", "Alice", [{ domainName: "x.com", expiresAt: new Date("2027-01-01") }]);
    expect(text()).toContain("  x.com — expires 2027-01-01");
    expect(text()).toContain("/dashboard/dns-management");
  });

  it("registration failure: each domain with its error, and the refund promise", async () => {
    await sendDomainRegistrationFailureEmail("u@x.test", "Alice", [{ domainName: "x.com", error: "DNS error" }]);
    expect(text()).toContain("  x.com — DNS error");
    expect(text()).toMatch(/You will receive a refund for any registration that fails/);
  });

  it("booking status: registered (years + expiry) and processing domains, order + domains links", async () => {
    await sendDomainBookingStatusEmail("u@x.test", "Alice", [
      { domainName: "x.com", status: "registered", registrationPeriod: 2, expiresAt: new Date("2028-01-01") },
      { domainName: "y.com", status: "processing", registrationPeriod: 1 },
    ], "ORD_42");
    expect(text()).toContain("Registered and active:\n  x.com — registered for 2 years, expires 2028-01-01");
    expect(text()).toContain("Still being processed:\n  y.com");
    expect(text()).toMatch(/another confirmation once they are active/);
    expect(text()).toContain("/dashboard/orders/ORD_42");
    expect(text()).toContain("/dashboard/domains");
  });

  it("grace period: days, suspension date and renew link", async () => {
    await sendServiceGracePeriodEmail("u@x.test", { serviceName: "x.com", serviceType: "hosting", graceDays: 7, graceEndsAt: new Date("2027-01-15") });
    expect(text()).toMatch(/hosting x\.com has expired\. It is now in a 7-day grace period and will be suspended on 15 January 2027 if it is not renewed\./);
    expect(text()).toMatch(/\n {2}\S*\/dashboard\n/);
  });

  it("domain available: the register link and the one-time notice", async () => {
    await sendDomainAvailableEmail("u@x.test", "wanted.com", "Alice");
    expect(text()).toContain("/domain-search?q=wanted.com");
    expect(text()).toMatch(/won't get more notifications for this domain unless you add it to your watch list again/);
  });
});

/*
 * The ResellerOS customer-email pattern (lib/email/plain.ts; owner, 3 Oct 2026): every customer
 * email from this file opens "Hi <first name>,", closes with the shared support line and the
 * brand sign-off, and has no banner, table, gradient or emoji.
 */
describe("every domain/service email follows the plain ResellerOS pattern", () => {
  const prevFrom = process.env.FROM_NAME;
  beforeEach(() => { process.env.FROM_NAME = "Anutech Digital"; });
  afterEach(() => { if (prevFrom === undefined) delete process.env.FROM_NAME; else process.env.FROM_NAME = prevFrom; });

  const EMOJI = /\p{Extended_Pictographic}/u;
  const cases: Array<[string, string, () => Promise<boolean>]> = [
    ["sendDomainPurchaseEmail", "Alice", () => sendDomainPurchaseEmail("u@x.test", "Alice Smith", [{ domainName: "x.com", price: 500, status: "registered" }], 500)],
    ["sendDomainRegistrationEmail", "Alice", () => sendDomainRegistrationEmail("u@x.test", "Alice Smith", [{ domainName: "x.com", expiresAt: new Date("2027-01-01") }])],
    ["sendDomainRegistrationFailureEmail", "Alice", () => sendDomainRegistrationFailureEmail("u@x.test", "Alice Smith", [{ domainName: "x.com", error: "DNS error" }])],
    ["sendDomainBookingStatusEmail", "Alice", () => sendDomainBookingStatusEmail("u@x.test", "Alice Smith", [{ domainName: "x.com", status: "registered", registrationPeriod: 1, expiresAt: new Date("2027-01-01") }, { domainName: "y.com", status: "pending", registrationPeriod: 1 }], "ORD_1")],
    ["sendServiceReminderEmail (urgent, pay)", "Alice", () => sendServiceReminderEmail("u@x.test", { serviceName: "x.com", serviceType: "hosting", daysRemaining: 0, renewal: { kind: "pay", paymentUrl: "https://ros.test/q/1" }, userName: "Alice Smith" })],
    ["sendServiceReminderEmail (7 days, no name)", "there", () => sendServiceReminderEmail("u@x.test", { serviceName: "x.com", serviceType: "domain", daysRemaining: 7, renewal: { kind: "unknown" } })],
    ["sendServiceExpiryTodayEmail", "Alice", () => sendServiceExpiryTodayEmail("u@x.test", { serviceName: "x.com", serviceType: "domain", userName: "Alice Smith" })],
    ["sendServiceSuspensionEmail (tokens)", "there", () => sendServiceSuspensionEmail("u@x.test", { serviceName: "x.com", serviceType: "hosting", mandateMode: "tokens" })],
    ["sendServiceGracePeriodEmail", "there", () => sendServiceGracePeriodEmail("u@x.test", { serviceName: "x.com", serviceType: "hosting", graceDays: 7, graceEndsAt: new Date("2027-01-15") })],
    ["sendDomainAvailableEmail", "Alice", () => sendDomainAvailableEmail("u@x.test", "wanted.com", "Alice Smith")],
  ];

  it.each(cases)("%s", async (_name, first, send) => {
    expect(await send()).toBe(true);
    const { subject, text, html } = sendEmailMock.mock.calls[0][0];
    expect(text.startsWith(`Hi ${first},\n\n`)).toBe(true);
    // Notification emails get one plain unsubscribe line after the sign-off (lib/email/notifications.ts).
    expect(text).toMatch(/\n\n— Anutech Digital(\n\nDon't want these emails\? Unsubscribe: \S+)?$/);
    expect(text).toContain("Questions? Reply to this email or write to support@anutech.in.");
    for (const s of [subject, text, html]) expect(String(s)).not.toMatch(EMOJI);
    expect(html).not.toMatch(/gradient|<table|<h[1-6]/i);
    expect(`${text}${html}`).not.toMatch(/Private Limited Team|Domain Management System/);
  });
});
