/**
 * Tests for lib/email/notifications.ts — the non-essential email path.
 * Suppresses when the recipient opted out; otherwise adds the unsubscribe
 * footer + List-Unsubscribe header.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/transporter", () => ({
  sendEmail,
  SUPPORT_EMAIL: "support@anutech.in",
}));

const getUserByEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserByEmail }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/unsubscribe-token", () => ({
  unsubscribeUrl: (email: string) => `https://app.test/api/notifications/unsubscribe?token=TOK-${email}`,
}));

import { sendNotificationEmail } from "@/lib/email/notifications";

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue(true);
  getUserByEmail.mockReset();
});

describe("sendNotificationEmail", () => {
  it("SUPPRESSES the send when the user has opted out", async () => {
    getUserByEmail.mockResolvedValueOnce({ emailOptOut: true });
    const ok = await sendNotificationEmail({ to: "a@x.com", subject: "S", html: "<p>Hi</p>" });
    expect(ok).toBe(true); // success from caller's view
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends with an unsubscribe footer + List-Unsubscribe URL when not opted out", async () => {
    getUserByEmail.mockResolvedValueOnce({ emailOptOut: false });
    await sendNotificationEmail({ to: "a@x.com", subject: "S", html: "<p>Body</p>" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [opts] = sendEmail.mock.calls[0];
    expect(opts.html).toContain("<p>Body</p>");
    expect(opts.html).toContain("Unsubscribe from these notifications");
    expect(opts.listUnsubscribeUrl).toBe("https://app.test/api/notifications/unsubscribe?token=TOK-a@x.com");
  });

  it("sends when the user is unknown (lookup miss → not suppressed)", async () => {
    getUserByEmail.mockResolvedValueOnce(null);
    await sendNotificationEmail({ to: "guest@x.com", subject: "S", html: "<p>x</p>" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("sends anyway if the opt-out lookup throws (never blocks on a lookup error)", async () => {
    getUserByEmail.mockRejectedValueOnce(new Error("db down"));
    await sendNotificationEmail({ to: "a@x.com", subject: "S", html: "<p>x</p>" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
