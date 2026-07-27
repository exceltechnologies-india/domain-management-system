/**
 * Tests for `@/lib/email/hosting` (rescan-4 slice 7dr).
 * sendHostingProvisionedEmail composes the hosting-active welcome
 * email. Tests focus on the assembled HTML — the actual mail-delivery
 * is mocked at the `sendEmail` boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/transporter", () => ({
  sendEmail: sendEmailMock,
  SUPPORT_EMAIL: "support@anutech.test",
}));

import { sendHostingProvisionedEmail } from "@/lib/email/hosting";

const DETAILS = {
  domainName: "example.com",
  packageName: "basic",
  planName: "Starter",
  serverIp: "203.0.113.42",
  nameservers: ["ns1.anutech.in", "ns2.anutech.in", "ns3.anutech.in"],
};

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(true);
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
});

describe("sendHostingProvisionedEmail", () => {
  it("calls sendEmail with the recipient + subject and returns its boolean result", async () => {
    const ok = await sendHostingProvisionedEmail("ada@example.test", "Ada", DETAILS);
    expect(ok).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.to).toBe("ada@example.test");
    expect(opts.subject).toBe("Hosting Account Provisioned Successfully");
  });

  it("embeds the userName as the greeting", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada Lovelace", DETAILS);
    expect(sendEmailMock.mock.calls[0][0].html).toContain("Hello Ada Lovelace");
  });

  it("renders domain + packageName/planName + serverIp in the account details table", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", DETAILS);
    const html = sendEmailMock.mock.calls[0][0].html;
    expect(html).toContain("example.com");
    // planName preferred over packageName when both supplied.
    expect(html).toContain("Starter");
    expect(html).not.toContain(">basic<");
    expect(html).toContain("203.0.113.42");
  });

  it("falls back to packageName when planName is absent", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", {
      ...DETAILS,
      planName: undefined,
    });
    const html = sendEmailMock.mock.calls[0][0].html;
    expect(html).toContain(">basic<");
  });

  it("renders each nameserver as an <li>", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", DETAILS);
    const html = sendEmailMock.mock.calls[0][0].html;
    expect(html).toContain("<li>ns1.anutech.in</li>");
    expect(html).toContain("<li>ns2.anutech.in</li>");
    expect(html).toContain("<li>ns3.anutech.in</li>");
  });

  it("links to /dashboard/hosting on NEXTAUTH_URL", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", DETAILS);
    const html = sendEmailMock.mock.calls[0][0].html;
    expect(html).toContain("https://app.example.com/dashboard/hosting");
  });

  it("renders the SUPPORT_EMAIL mailto link", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", DETAILS);
    const html = sendEmailMock.mock.calls[0][0].html;
    expect(html).toContain(`mailto:support@anutech.test`);
  });

  it("propagates sendEmail false (delivery failure surfaces to caller)", async () => {
    sendEmailMock.mockResolvedValueOnce(false);
    const result = await sendHostingProvisionedEmail("u@e.test", "Ada", DETAILS);
    expect(result).toBe(false);
  });

  it("empty nameservers array → empty ul (graceful — no crash)", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", {
      ...DETAILS,
      nameservers: [],
    });
    const html = sendEmailMock.mock.calls[0][0].html;
    expect(html).not.toContain("<li>ns");
  });

  // Pins the Tokens-flow payment-validity callout introduced for the
  // unified hard 1-attempt MIT policy (d4b6a64). The callout MUST
  // appear ONLY when mandateMode='tokens' — Subscriptions-flow customers
  // (whose retries are still managed by Razorpay's Subscriptions API
  // server-side) would be misled by the strict-suspension language.
  describe("Tokens-flow payment-validity callout (d4b6a64)", () => {
    it("mandateMode='tokens' → renders the payment-validity callout block", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", {
        ...DETAILS,
        mandateMode: "tokens",
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).toContain("Keep Your Payment Method Valid");
      expect(html).toMatch(/single charge fails/i);
      expect(html).toMatch(/suspended/i);
      expect(html).toMatch(/re-subscribe/i);
    });

    it("mandateMode='tokens' + isTrial=true → callout ABSENT (trial email already explains day-15 billing; a 2nd scary warning is alarming on a ₹0 trial)", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", {
        ...DETAILS,
        mandateMode: "tokens",
        isTrial: true,
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).not.toContain("Keep Your Payment Method Valid");
      expect(html).not.toContain("single charge fails");
      // The trial banner + day-15 explainer still render.
      expect(html).toMatch(/15-Day Free Trial is Active/i);
    });

    it("mandateMode='subscriptions' → callout block ABSENT (anti-misinform existing subscription-mode customers)", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", {
        ...DETAILS,
        mandateMode: "subscriptions",
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).not.toContain("Keep Your Payment Method Valid");
      expect(html).not.toContain("single charge fails");
    });

    it("mandateMode='manual' → callout block ABSENT (manual billing means no auto-renewal at all)", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", {
        ...DETAILS,
        mandateMode: "manual",
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).not.toContain("Keep Your Payment Method Valid");
    });

    it("mandateMode UNSET (legacy callers + back-compat) → callout ABSENT", async () => {
      // The 4 non-Tokens call sites (provisioner-hosting, renewal,
      // pending-hostings, admin/hosting/provision) don't pass the field
      // — they should continue to render the original email shape.
      await sendHostingProvisionedEmail("u@e.test", "Ada", DETAILS);
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).not.toContain("Keep Your Payment Method Valid");
    });
  });

  // Trial-specific messaging — added 2026-07-03 so trial signups get
  // trial-aware copy (subject + header + banner + day-15 explainer +
  // CTA text) instead of the generic "provisioned" language operators
  // saw in the karmaastar test signup. Pins the new isTrial gate +
  // trialEndsAt formatting + defaults.
  describe("Trial-specific messaging (2026-07-03)", () => {
    const TRIAL_ENDS = new Date("2026-07-18T11:43:00.000Z");

    it("isTrial=true → subject uses trial-specific line naming the domain", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", {
        ...DETAILS,
        isTrial: true,
        trialEndsAt: TRIAL_ENDS,
      });
      const [opts] = sendEmailMock.mock.calls[0];
      expect(opts.subject).toBe("Your 15-Day Free Trial is Active — example.com");
    });

    it("isTrial=false / unset → subject uses the paid-account line (back-compat)", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", DETAILS);
      const [opts] = sendEmailMock.mock.calls[0];
      expect(opts.subject).toBe("Hosting Account Provisioned Successfully");
    });

    it("isTrial=true → header + banner + day-15 explainer + amber gradient all present", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", {
        ...DETAILS,
        isTrial: true,
        trialEndsAt: TRIAL_ENDS,
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).toContain("Your Free Trial is Live!");
      expect(html).toContain("Your 15-Day Free Trial is Active");
      expect(html).toMatch(/free until.*18 July 2026/);
      expect(html).toMatch(/What happens at day 15/i);
      expect(html).toMatch(/hosting will be suspended/i);
      expect(html).toContain("Start Using Your Trial");
      // Amber gradient signals trial branch — non-trial uses blue.
      expect(html).toContain("#F59E0B");
      expect(html).not.toContain("Service Activated");
    });

    it("isTrial=true + missing trialEndsAt → banner still renders WITHOUT the 'free until' date line", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", {
        ...DETAILS,
        isTrial: true,
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).toContain("Your Free Trial is Live!");
      expect(html).toContain("Your 15-Day Free Trial is Active");
      // The "free until <date>" fragment must be omitted rather than
      // rendering "free until undefined" or a Date-toString leak.
      expect(html).not.toMatch(/free until.*<strong>[<]/);
      expect(html).not.toContain("undefined");
    });

    it("isTrial=false → paid-account header + green banner (back-compat)", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", {
        ...DETAILS,
        isTrial: false,
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).toContain("Hosting Account Active");
      expect(html).toContain("Service Activated");
      expect(html).toContain("Go to Hosting Dashboard");
      expect(html).not.toContain("Your Free Trial is Live!");
      expect(html).not.toContain("What happens at day 15");
    });

    it("isTrial=true + mandateMode='tokens' → trial banner renders, Tokens payment-validity callout SUPPRESSED (operator request 2026-07-27: no scary second warning on a ₹0 trial)", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", {
        ...DETAILS,
        isTrial: true,
        trialEndsAt: TRIAL_ENDS,
        mandateMode: "tokens",
      });
      const html = sendEmailMock.mock.calls[0][0].html;
      expect(html).toContain("Your 15-Day Free Trial is Active");
      expect(html).not.toContain("Keep Your Payment Method Valid");
    });
  });
});
