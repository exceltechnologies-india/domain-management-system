/**
 * Tests for `@/lib/email/auth` (rescan-4 slice 7el).
 * Auth-related email templates, written as plain text in the ResellerOS
 * pattern (lib/email/plain.ts; owner, 3 Oct 2026) and sent via sendEmail()
 * with html = plainEmailHtml(text). We pin:
 *  - The subject line (drives the user's inbox preview — copy changes
 *    here have UX-visible consequences)
 *  - The recipient = userEmail param (no silent CC/BCC)
 *  - **Action URL is built from the right env source** (NEXTAUTH_URL
 *    for reset/setup; APP_URL>NEXTAUTH_URL>literal fallback for
 *    activation — the activation flow has a different fallback chain
 *    to accommodate marketing-site activations)
 *  - **isSetup branch on sendPasswordResetEmail** flips the subject +
 *    wording + adds `&setup=1` query param to the URL (the
 *    guest→full-account flow distinct from password recovery)
 *  - sendEmail return propagates (true on success, false on failure
 *    — callers can decide whether to surface the failure)
 *  - User-supplied params (firstName/userName/resetToken/activationToken)
 *    appear in the body
 *  - The shared pattern on every one: "Hi <first name>," ... support address
 *    ... "— <brand>", no gradients or emoji
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendEmailMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("@/lib/email/transporter", () => ({
  sendEmail: sendEmailMock,
  SUPPORT_EMAIL: "support@anutech.in",
}));

// sendProfileCompletionEmail routes through the non-essential notification
// helper (opt-out + unsubscribe footer). Stub its deps so these template
// tests still exercise the real HTML builder → sendEmail.
vi.mock("@/lib/services/users", () => ({
  getUserByEmail: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/unsubscribe-token", () => ({
  unsubscribeUrl: () => "https://app.test/api/notifications/unsubscribe?token=T",
}));
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendPasswordResetNotificationEmail,
  sendPasswordChangeNotificationEmail,
  sendProfileUpdateEmail,
  sendProfileCompletionEmail,
  sendActivationEmail,
} from "@/lib/email/auth";

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(true);
  vi.stubEnv("NEXTAUTH_URL", "https://app.test.example");
  vi.stubEnv("APP_URL", "https://marketing.test.example");
  vi.stubEnv("FROM_NAME", "Anutech Digital");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sendWelcomeEmail", () => {
  it("subject + recipient + propagates sendEmail return", async () => {
    const result = await sendWelcomeEmail("user@x.test", "Alice");
    expect(result).toBe(true);
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.to).toBe("user@x.test");
    expect(opts.subject).toBe("Welcome to Anutech Digital");
    expect(opts.text).toContain("Alice");
    expect(opts.text).toContain("https://app.test.example/dashboard");
    expect(opts.html).toContain('href="https://app.test.example/dashboard"');
  });

  it("sendEmail returns false → propagates false", async () => {
    sendEmailMock.mockResolvedValueOnce(false);
    expect(await sendWelcomeEmail("user@x.test", "Alice")).toBe(false);
  });
});

describe("sendPasswordResetEmail — isSetup branch flips subject + URL + wording", () => {
  it("default (recovery flow): subject 'Password reset request' + URL has no setup flag", async () => {
    await sendPasswordResetEmail("user@x.test", "Alice", "TOKEN_42");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.subject).toBe("Password reset request");
    expect(opts.text).toContain(
      "  https://app.test.example/reset-password?token=TOKEN_42\n"
    );
    expect(opts.text).not.toContain("setup=1");
    expect(opts.text).toMatch(/reset your password/);
    expect(opts.text).toContain("expires in 1 hour");
    expect(opts.text).toContain("If you didn't ask for a password reset, please ignore this email");
  });

  it("isSetup:true → subject 'Set up your account password' + URL has &setup=1 + setup wording", async () => {
    await sendPasswordResetEmail("user@x.test", "Alice", "TOKEN_42", true);
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.subject).toBe("Set up your account password");
    expect(opts.text).toContain(
      "  https://app.test.example/reset-password?token=TOKEN_42&setup=1\n"
    );
    // The & is escaped in the HTML part, and the link stays clickable.
    expect(opts.html).toContain(
      'href="https://app.test.example/reset-password?token=TOKEN_42&amp;setup=1"'
    );
    expect(opts.text).toMatch(/set your password/);
    expect(opts.text).toContain("expires in 1 hour");
    expect(opts.text).toContain("If you didn't sign up, you can safely ignore this email.");
  });
});

describe("sendPasswordResetNotificationEmail", () => {
  it("subject 'Your password has been reset' + recipient + new password + login link", async () => {
    await sendPasswordResetNotificationEmail("user@x.test", "Alice", "newPass123");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.to).toBe("user@x.test");
    expect(opts.subject).toBe("Your password has been reset");
    expect(opts.text).toContain("Alice");
    expect(opts.text).toContain("reset by an administrator");
    expect(opts.text).toContain("  newPass123\n");
    expect(opts.text).toContain("https://app.test.example/login");
    expect(opts.text).toContain("Do not share this password");
  });
});

describe("sendPasswordChangeNotificationEmail", () => {
  it("default branch: 'Password changed successfully'", async () => {
    await sendPasswordChangeNotificationEmail("user@x.test", "Alice");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.subject).toBe("Password changed successfully");
    expect(opts.text).toContain("Your password has been changed successfully.");
    expect(opts.text).toContain("If you did not change your password yourself");
    expect(opts.text).not.toContain("social login");
    expect(opts.text).toContain("https://app.test.example/dashboard");
  });

  it("isFirstTimeSet:true → 'Password set successfully' + login options with the provider", async () => {
    await sendPasswordChangeNotificationEmail("user@x.test", "Alice", true, "google");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.subject).toBe("Password set successfully");
    expect(opts.text).toContain("Your password has been set successfully.");
    expect(opts.text).toContain("social login account (Google)");
    expect(opts.text).toContain("If you did not set your password yourself");
  });
});

describe("sendProfileUpdateEmail", () => {
  it("subject 'Profile updated successfully' + recipient", async () => {
    await sendProfileUpdateEmail("user@x.test", "Alice");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.to).toBe("user@x.test");
    expect(opts.subject).toBe("Profile updated successfully");
    expect(opts.text).toContain("If you did not make these changes");
  });

  it("lists the supplied field labels that changed", async () => {
    await sendProfileUpdateEmail("user@x.test", "Alice", [
      "Phone number",
      "WhatsApp number",
    ]);
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.text).toContain("These details on your profile were updated:");
    expect(opts.text).toContain("  - Phone number\n  - WhatsApp number");
  });

  it("omits the changed-fields list when no fields are supplied (generic copy)", async () => {
    await sendProfileUpdateEmail("user@x.test", "Alice");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.text).not.toContain("These details on your profile were updated");
    expect(opts.text).toContain("Your profile information has been updated.");
  });

  it("escapes HTML in field labels (defensive)", async () => {
    await sendProfileUpdateEmail("user@x.test", "Alice", ["<script>x</script>"]);
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.html).not.toContain("<script>x</script>");
    expect(opts.html).toContain("&lt;script&gt;");
  });
});

describe("sendProfileCompletionEmail", () => {
  it("subject 'Complete your profile' + URL goes to dashboard/settings + keeps the unsubscribe link", async () => {
    await sendProfileCompletionEmail("user@x.test", "Alice");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.subject).toBe("Complete your profile");
    expect(opts.text).toContain(
      "  https://app.test.example/dashboard/settings\n"
    );
    expect(opts.html).toContain(
      'href="https://app.test.example/dashboard/settings"'
    );
    expect(opts.listUnsubscribeUrl).toBe("https://app.test/api/notifications/unsubscribe?token=T");
  });
});

describe("sendActivationEmail — fallback chain APP_URL > NEXTAUTH_URL > literal", () => {
  it("APP_URL wins when set", async () => {
    await sendActivationEmail("user@x.test", "Alice", "TOK");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.text).toContain("https://marketing.test.example/activate?token=TOK");
  });

  it("APP_URL unset → falls back to NEXTAUTH_URL", async () => {
    vi.stubEnv("APP_URL", "");
    await sendActivationEmail("user@x.test", "Alice", "TOK");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.text).toContain("https://app.test.example/activate?token=TOK");
  });

  it("both unset → literal fallback 'https://app.anutech.in'", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    await sendActivationEmail("user@x.test", "Alice", "TOK");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.text).toContain("https://app.anutech.in/activate?token=TOK");
  });

  it("token + userName + 24-hour expiry rendered into the body", async () => {
    await sendActivationEmail("user@x.test", "Alice", "TOK_ABC");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.subject).toBe("Activate your account");
    expect(opts.text).toContain("Alice");
    expect(opts.text).toContain("TOK_ABC");
    expect(opts.html).toContain("TOK_ABC");
    expect(opts.text).toContain("expires in 24 hours");
    expect(opts.text).toContain("If you didn't create an account, please ignore it.");
  });
});

describe("every auth email follows the shared ResellerOS pattern", () => {
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const cases: Array<[string, () => Promise<boolean>]> = [
    ["sendWelcomeEmail", () => sendWelcomeEmail("user@x.test", "Alice Smith")],
    ["sendPasswordResetEmail", () => sendPasswordResetEmail("user@x.test", "Alice Smith", "T")],
    ["sendPasswordResetEmail (setup)", () => sendPasswordResetEmail("user@x.test", "Alice Smith", "T", true)],
    ["sendPasswordResetNotificationEmail", () => sendPasswordResetNotificationEmail("user@x.test", "Alice Smith", "pw")],
    ["sendPasswordChangeNotificationEmail", () => sendPasswordChangeNotificationEmail("user@x.test", "Alice Smith", true, "google")],
    ["sendProfileUpdateEmail", () => sendProfileUpdateEmail("user@x.test", "Alice Smith", ["Phone number"])],
    ["sendProfileCompletionEmail", () => sendProfileCompletionEmail("user@x.test", "Alice Smith")],
    ["sendActivationEmail", () => sendActivationEmail("user@x.test", "Alice Smith", "T")],
  ];

  it.each(cases)("%s: Hi <first name>, ... support ... — brand; plain html", async (_name, run) => {
    expect(await run()).toBe(true);
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.text.startsWith("Hi Alice,\n\n")).toBe(true);
    // sendProfileCompletionEmail is non-essential: sendNotificationEmail may add its plain
    // unsubscribe line after the sign-off, so the closing is checked before that line.
    const body = opts.text.replace(/\n\nDon't want these emails\? Unsubscribe: \S+$/, "");
    expect(body.endsWith("Questions? Reply to this email or write to support@anutech.in.\n\n— Anutech Digital")).toBe(true);
    expect(opts.text).not.toMatch(/Private Limited|Domain Management/);
    expect(opts.subject).not.toMatch(EMOJI);
    expect(opts.text).not.toMatch(EMOJI);
    expect(opts.html).not.toMatch(/gradient/i);
    expect(opts.html).not.toMatch(EMOJI);
  });
});
