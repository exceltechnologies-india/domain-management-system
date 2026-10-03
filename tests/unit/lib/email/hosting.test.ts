/**
 * Hosting emails to the customer — in the ResellerOS pattern (Pawan, 3 Oct 2026: the two apps'
 * emails must be identical; DMS is a backend for ResellerOS). Plain sentences, the Customer
 * Portal link, a signed close — no banners, gradients or emoji. What each email SAYS is pinned
 * here; delivery is mocked at the `sendEmail` boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/transporter", () => ({
  sendEmail: sendEmailMock,
  SUPPORT_EMAIL: "support@anutech.test",
}));

import { sendHostingProvisionedEmail, sendHostingTrialCancelledEmail, sendHostingTerminatedEmail } from "@/lib/email/hosting";

const DETAILS = {
  domainName: "example.com",
  packageName: "basic",
  planName: "Starter",
  serverIp: "203.0.113.42",
  nameservers: ["ns1.anutech.in", "ns2.anutech.in", "ns3.anutech.in"],
};
const sent = () => sendEmailMock.mock.calls[0][0] as { to: string; subject: string; text: string; html: string };

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(true);
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
  vi.stubEnv("FROM_NAME", "Anutech Digital");
});

describe("the shared pattern", () => {
  it("every hosting email: 'Hi <first name>', the support address, signed by the brand, no banners or emoji", async () => {
    await sendHostingProvisionedEmail("ada@example.test", "Ada Lovelace", DETAILS);
    await sendHostingTrialCancelledEmail("ada@example.test", "Ada Lovelace", { domainName: "example.com" });
    await sendHostingTerminatedEmail("ada@example.test", "Ada Lovelace", { domainName: "example.com" });
    for (const [m] of sendEmailMock.mock.calls) {
      expect(m.to).toBe("ada@example.test");
      expect(m.text).toMatch(/^Hi Ada,\n/);
      expect(m.text).toContain("support@anutech.test");
      expect(m.text).toMatch(/— Anutech Digital$/);
      expect(m.text).not.toMatch(/[🎉✅⚠️]/u);
      expect(m.html).not.toMatch(/gradient|#F59E0B|<h1|<table/i);
      expect(m.html).toContain('href="mailto:support@anutech.test"');
      expect(m.text).not.toMatch(/Anutech Digital Private Limited Team|Domain Management/i);
    }
  });

  it("the HTML part carries the same words as the text part", async () => {
    await sendHostingTerminatedEmail("u@e.test", "Ada", { domainName: "example.com" });
    const m = sent();
    for (const line of m.text.split("\n").filter(Boolean)) expect(m.html).toContain(line.replace(/&/g, "&amp;").split("support@")[0].slice(0, 30));
  });

  it("no name → 'Hi there'", async () => {
    await sendHostingTerminatedEmail("u@e.test", "", { domainName: "example.com" });
    expect(sent().text).toMatch(/^Hi there,/);
  });

  it("propagates sendEmail false (delivery failure surfaces to caller)", async () => {
    sendEmailMock.mockResolvedValueOnce(false);
    expect(await sendHostingProvisionedEmail("u@e.test", "Ada", DETAILS)).toBe(false);
  });
});

describe("sendHostingProvisionedEmail", () => {
  it("paid: subject names plan and domain; body has the portal link, nameservers and server IP", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", DETAILS);
    const m = sent();
    expect(m.subject).toBe("Your Starter hosting is live — example.com");
    expect(m.text).toContain("Your Starter hosting for example.com is ready.");
    expect(m.text).toContain("https://app.example.com/login");
    expect(m.text).toContain("Customer Portal");
    for (const ns of DETAILS.nameservers) expect(m.text).toContain(`  ${ns}`);
    expect(m.text).toContain("Server IP: 203.0.113.42");
    expect(m.html).toContain('<a href="https://app.example.com/login">');
  });

  it("planName preferred; packageName when it is missing", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", { ...DETAILS, planName: undefined });
    expect(sent().subject).toBe("Your basic hosting is live — example.com");
  });

  it("no nameservers → still the server IP, no empty list", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", { ...DETAILS, nameservers: [] });
    expect(sent().text).toContain("Server IP: 203.0.113.42");
    expect(sent().text).not.toContain("nameservers");
  });

  it("trial: says trial, until when, and that nothing is charged", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", { ...DETAILS, isTrial: true, trialEndsAt: new Date("2026-07-18T11:43:00.000Z") });
    const m = sent();
    expect(m.subject).toBe("Your 15-day Starter hosting trial is live — example.com");
    expect(m.text).toMatch(/free until 18 July 2026/);
    expect(m.text).toContain("nothing charged");
  });

  it("trial with no end date → no 'free until' fragment, no 'undefined'", async () => {
    await sendHostingProvisionedEmail("u@e.test", "Ada", { ...DETAILS, isTrial: true });
    expect(sent().text).not.toContain("free until");
    expect(sent().text).not.toContain("undefined");
  });

  describe("Tokens-flow renewal warning (d4b6a64)", () => {
    it("paid + tokens → the single-charge warning", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", { ...DETAILS, mandateMode: "tokens" });
      expect(sent().text).toMatch(/single charge fails/);
      expect(sent().text).toMatch(/suspended/);
    });
    it("trial + tokens → no warning on a ₹0 trial (operator, 2026-07-27)", async () => {
      await sendHostingProvisionedEmail("u@e.test", "Ada", { ...DETAILS, mandateMode: "tokens", isTrial: true });
      expect(sent().text).not.toMatch(/single charge fails/);
    });
    for (const mode of ["subscriptions", "manual", undefined] as const) {
      it(`mandateMode ${String(mode)} → no warning`, async () => {
        await sendHostingProvisionedEmail("u@e.test", "Ada", { ...DETAILS, mandateMode: mode });
        expect(sent().text).not.toMatch(/single charge fails/);
      });
    }
  });
});

describe("sendHostingTrialCancelledEmail", () => {
  it("names the domain and says nothing was charged", async () => {
    await sendHostingTrialCancelledEmail("u@e.test", "Ada", { domainName: "example.com" });
    expect(sent().subject).toBe("Your free trial has been cancelled — example.com");
    expect(sent().text).toContain("You have not been charged");
  });
});

describe("sendHostingTerminatedEmail", () => {
  it("names the domain and what was removed, and how to get it back", async () => {
    await sendHostingTerminatedEmail("u@e.test", "Ada", { domainName: "example.com" });
    const m = sent();
    expect(m.subject).toBe("Your hosting for example.com has been removed");
    expect(m.text).toContain("website files, databases and email accounts have been deleted");
    expect(m.text).toMatch(/reply to this email/i);
  });
});
