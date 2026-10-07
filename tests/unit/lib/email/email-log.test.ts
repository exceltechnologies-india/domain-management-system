/**
 * Every send attempt leaves a row in EmailLog (7 Oct 2026): accepted, failed or skipped — and
 * a log that cannot be written never stops the email. No body is stored (one-time passwords).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const createTransportMock = vi.hoisted(() => vi.fn());
vi.mock("nodemailer", () => ({ default: { createTransport: createTransportMock } }));
const lookupMock = vi.hoisted(() => vi.fn(async () => ({ address: "203.0.113.25", family: 4 })));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock, default: { lookup: lookupMock } }));
vi.mock("@/lib/server-logger", () => ({ serverLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
const logCreate = vi.hoisted(() => vi.fn(async (_row: Record<string, unknown>) => ({})));
vi.mock("@/models/EmailLog", () => ({ default: { create: logCreate } }));
vi.mock("@/lib/mongodb", () => ({ default: vi.fn(async () => {}) }));

const sendMail = vi.fn();
beforeEach(() => {
  vi.resetModules();
  logCreate.mockReset().mockResolvedValue({});
  sendMail.mockReset();
  createTransportMock.mockReset().mockReturnValue({ verify: vi.fn(async () => true), sendMail });
  for (const [k, v] of Object.entries({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_USER: "noreply@example.com", SMTP_PASS: "x", FROM_EMAIL: "noreply@example.com", FROM_NAME: "Anutech" })) vi.stubEnv(k, v);
});
afterEach(() => vi.unstubAllEnvs());

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("the DMS email send log", () => {
  it("an accepted send is logged as sent, with the message id — never the body", async () => {
    sendMail.mockResolvedValueOnce({ messageId: "<m1@example.com>", response: "250 2.0.0 OK" });
    const { sendEmail } = await import("@/lib/email/transporter");
    expect(await sendEmail({ to: "a@example.in", subject: "Your Customer Portal is ready", html: "<p>pw Kp7m-Xq3a-Wz9t</p>", text: "pw Kp7m-Xq3a-Wz9t" })).toBe(true);
    await flush();
    expect(logCreate).toHaveBeenCalledWith(expect.objectContaining({ to: "a@example.in", subject: "Your Customer Portal is ready", status: "sent", messageId: "<m1@example.com>", response: "250 2.0.0 OK" }));
    expect(JSON.stringify(logCreate.mock.calls[0][0])).not.toContain("Kp7m-Xq3a-Wz9t");
  });
  it("a refused send is logged as failed with the reason", async () => {
    sendMail.mockRejectedValueOnce(new Error("451 4.3.0 temporarily rejected"));
    const { sendEmail } = await import("@/lib/email/transporter");
    expect(await sendEmail({ to: "a@example.in", subject: "S", html: "h" })).toBe(false);
    await flush();
    expect(logCreate).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: "451 4.3.0 temporarily rejected" }));
  });
  it("an invalid address is logged as skipped", async () => {
    const { sendEmail } = await import("@/lib/email/transporter");
    expect(await sendEmail({ to: "not-an-email", subject: "S", html: "h" })).toBe(false);
    await flush();
    expect(logCreate).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped" }));
    expect(sendMail).not.toHaveBeenCalled();
  });
  it("a log that cannot be written does not stop the email", async () => {
    logCreate.mockRejectedValueOnce(new Error("mongo down"));
    sendMail.mockResolvedValueOnce({ messageId: "<m2@example.com>" });
    const { sendEmail } = await import("@/lib/email/transporter");
    expect(await sendEmail({ to: "a@example.in", subject: "S", html: "h" })).toBe(true);
    await flush();
  });
});
