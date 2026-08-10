/**
 * Tests for `@/lib/email/transporter` (rescan-4 slice 7dm).
 * The shared nodemailer transporter + sendEmail wrapper. Pins:
 *  - Module-load throws when required env is missing
 *  - SPF alignment warning when FROM_EMAIL and SMTP_USER domains differ
 *  - getTransporter creates with the right config and caches the result
 *  - getTransporter throws after a verify() failure
 *  - sendEmail rejects invalid recipient addresses (returns false, no send)
 *  - sendEmail success → sendMail called with `"NAME" <FROM>`, returns true
 *  - sendEmail catches sendMail errors → returns false (no throw)
 *
 * Env vars + nodemailer mock both set before the static import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const createTransportMock = vi.hoisted(() => vi.fn());
vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

const loggerError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: loggerError, warn: loggerWarn, info: vi.fn() },
}));

function stubEmailEnv(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "noreply@example.com",
    SMTP_PASS: "secret",
    FROM_EMAIL: "noreply@example.com",
    FROM_NAME: "Anutech",
  };
  const merged = { ...defaults, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    vi.stubEnv(k, v);
  }
}

beforeEach(() => {
  vi.resetModules();
  createTransportMock.mockReset();
  loggerError.mockReset();
  loggerWarn.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("module-load env validation", () => {
  it("throws when SMTP_HOST is missing", async () => {
    stubEmailEnv({ SMTP_HOST: "" });
    await expect(import("@/lib/email/transporter")).rejects.toThrow(
      /Email configuration is missing/
    );
  });

  it("throws when FROM_EMAIL is missing", async () => {
    stubEmailEnv({ FROM_EMAIL: "" });
    await expect(import("@/lib/email/transporter")).rejects.toThrow(
      /Email configuration is missing/
    );
  });

  it("warns when FROM_EMAIL domain differs from SMTP_USER domain (SPF alignment)", async () => {
    stubEmailEnv({
      FROM_EMAIL: "no-reply@anutech.in",
      SMTP_USER: "auth@example.com",
    });
    await import("@/lib/email/transporter");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0][0]).toMatch(/SPF alignment/);
  });

  it("does NOT warn when FROM_EMAIL and SMTP_USER share a domain", async () => {
    stubEmailEnv({
      FROM_EMAIL: "no-reply@example.com",
      SMTP_USER: "auth@example.com",
    });
    await import("@/lib/email/transporter");
    expect(loggerWarn).not.toHaveBeenCalled();
  });
});

describe("getTransporter", () => {
  it("creates a transporter with the env config and verify()s it", async () => {
    stubEmailEnv();
    const verifyMock = vi.fn().mockResolvedValue(true);
    createTransportMock.mockReturnValue({ verify: verifyMock });
    const { getTransporter } = await import("@/lib/email/transporter");
    await getTransporter();
    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: { user: "noreply@example.com", pass: "secret" },
    });
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it("caches the transporter — second call does not re-create", async () => {
    stubEmailEnv();
    const verifyMock = vi.fn().mockResolvedValue(true);
    createTransportMock.mockReturnValue({ verify: verifyMock });
    const { getTransporter } = await import("@/lib/email/transporter");
    await getTransporter();
    await getTransporter();
    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it("throws when verify() rejects (caught + re-thrown with a clean error)", async () => {
    stubEmailEnv();
    createTransportMock.mockReturnValue({
      verify: vi.fn().mockRejectedValue(new Error("SMTP auth failed")),
    });
    const { getTransporter } = await import("@/lib/email/transporter");
    await expect(getTransporter()).rejects.toThrow(
      /Email transporter configuration failed/
    );
    expect(loggerError).toHaveBeenCalled();
  });
});

describe("sendEmail", () => {
  it("rejects an invalid recipient address (returns false, no transporter call)", async () => {
    stubEmailEnv();
    const sendMailMock = vi.fn();
    createTransportMock.mockReturnValue({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: sendMailMock,
    });
    const { sendEmail } = await import("@/lib/email/transporter");
    const result = await sendEmail({
      to: "not-an-email",
      subject: "Test",
      html: "<p>hi</p>",
    });
    expect(result).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringMatching(/Invalid recipient/));
  });

  it("success → sendMail called with the right shape + returns true", async () => {
    stubEmailEnv();
    const sendMailMock = vi.fn().mockResolvedValue({ messageId: "abc" });
    createTransportMock.mockReturnValue({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: sendMailMock,
    });
    const { sendEmail } = await import("@/lib/email/transporter");
    const result = await sendEmail({
      to: "user@example.test",
      subject: "Welcome",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(result).toBe(true);
    expect(sendMailMock).toHaveBeenCalledWith({
      from: `"Anutech" <noreply@example.com>`,
      to: "user@example.test",
      subject: "Welcome",
      text: "Hi",
      html: "<p>Hi</p>",
      // Defaults to SUPPORT_EMAIL (support@anutech.in) when caller omits replyTo.
      replyTo: "support@anutech.in",
    });
  });

  it("sendMail rejection is swallowed → returns false (no throw)", async () => {
    stubEmailEnv();
    const sendMailMock = vi.fn().mockRejectedValue(new Error("SMTP 550 mailbox full"));
    createTransportMock.mockReturnValue({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: sendMailMock,
    });
    const { sendEmail } = await import("@/lib/email/transporter");
    const result = await sendEmail({
      to: "user@example.test",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(result).toBe(false);
    expect(loggerError).toHaveBeenCalledWith(
      "Email sending error:",
      expect.any(Error)
    );
  });
});
