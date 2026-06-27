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
});
