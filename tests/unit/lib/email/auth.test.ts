/**
 * Tests for `@/lib/email/auth` (rescan-4 slice 7el).
 * Auth-related email templates. These are mostly HTML-construction
 * wrappers around sendEmail(), so we pin:
 *  - The subject line (drives the user's inbox preview — copy changes
 *    here have UX-visible consequences)
 *  - The recipient = userEmail param (no silent CC/BCC)
 *  - **Action URL is built from the right env source** (NEXTAUTH_URL
 *    for reset/setup; APP_URL>NEXTAUTH_URL>literal fallback for
 *    activation — the activation flow has a different fallback chain
 *    to accommodate marketing-site activations)
 *  - **isSetup branch on sendPasswordResetEmail** flips the subject +
 *    button label + adds `&setup=1` query param to the URL (the
 *    guest→full-account flow distinct from password recovery)
 *  - sendEmail return propagates (true on success, false on failure
 *    — callers can decide whether to surface the failure)
 *  - User-supplied params (firstName/userName/resetToken/activationToken)
 *    appear in the HTML body
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
    expect(opts.subject).toMatch(/Welcome.*Domain Management/);
    expect(opts.html).toContain("Alice");
    expect(opts.html).toContain("https://app.test.example/dashboard");
  });

  it("sendEmail returns false → propagates false", async () => {
    sendEmailMock.mockResolvedValueOnce(false);
    expect(await sendWelcomeEmail("user@x.test", "Alice")).toBe(false);
  });
});

describe("sendPasswordResetEmail — isSetup branch flips subject + URL + button", () => {
  it("default (recovery flow): subject 'Password Reset Request' + URL has no setup flag", async () => {
    await sendPasswordResetEmail("user@x.test", "Alice", "TOKEN_42");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.subject).toBe("Password Reset Request");
    expect(opts.html).toContain(
      "https://app.test.example/reset-password?token=TOKEN_42"
    );
    expect(opts.html).not.toContain("setup=1");
    expect(opts.html).toMatch(/Reset Password/);
  });

  it("isSetup:true → subject 'Set up your account password' + URL has &setup=1 + button label changes", async () => {
    await sendPasswordResetEmail("user@x.test", "Alice", "TOKEN_42", true);
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.subject).toBe("Set up your account password");
    expect(opts.html).toContain(
      "https://app.test.example/reset-password?token=TOKEN_42&setup=1"
    );
    expect(opts.html).toMatch(/Set Password/);
  });
});

describe("sendPasswordResetNotificationEmail", () => {
  it("subject 'Your Password Has Been Reset' + sends to recipient", async () => {
    await sendPasswordResetNotificationEmail("user@x.test", "Alice", "newPass123");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.to).toBe("user@x.test");
    expect(opts.subject).toBe("Your Password Has Been Reset");
    expect(opts.html).toContain("Alice");
  });
});

describe("sendPasswordChangeNotificationEmail", () => {
  it("default branch: 'Password Changed Successfully'", async () => {
    await sendPasswordChangeNotificationEmail("user@x.test", "Alice");
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Password Changed Successfully"
    );
  });

  it("isFirstTimeSet:true → 'Password Set Successfully'", async () => {
    await sendPasswordChangeNotificationEmail("user@x.test", "Alice", true);
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Password Set Successfully"
    );
  });
});

describe("sendProfileUpdateEmail", () => {
  it("subject 'Profile Updated Successfully' + recipient", async () => {
    await sendProfileUpdateEmail("user@x.test", "Alice");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.to).toBe("user@x.test");
    expect(opts.subject).toBe("Profile Updated Successfully");
  });

  it("renders a 'What changed' list with the supplied field labels", async () => {
    await sendProfileUpdateEmail("user@x.test", "Alice", [
      "Phone number",
      "WhatsApp number",
    ]);
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.html).toContain("What changed:");
    expect(opts.html).toContain("<li>Phone number</li>");
    expect(opts.html).toContain("<li>WhatsApp number</li>");
  });

  it("omits the 'What changed' list when no fields are supplied (generic copy)", async () => {
    await sendProfileUpdateEmail("user@x.test", "Alice");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.html).not.toContain("What changed:");
  });

  it("escapes HTML in field labels (defensive)", async () => {
    await sendProfileUpdateEmail("user@x.test", "Alice", ["<script>x</script>"]);
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.html).not.toContain("<script>x</script>");
    expect(opts.html).toContain("&lt;script&gt;");
  });
});

describe("sendProfileCompletionEmail", () => {
  it("subject mentions 'Complete Your Profile' + URL goes to dashboard/settings", async () => {
    await sendProfileCompletionEmail("user@x.test", "Alice");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.subject).toMatch(/Complete Your Profile/);
    expect(opts.html).toContain(
      "https://app.test.example/dashboard/settings"
    );
  });
});

describe("sendActivationEmail — fallback chain APP_URL > NEXTAUTH_URL > literal", () => {
  it("APP_URL wins when set", async () => {
    await sendActivationEmail("user@x.test", "Alice", "TOK");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.html).toContain("https://marketing.test.example/activate?token=TOK");
  });

  it("APP_URL unset → falls back to NEXTAUTH_URL", async () => {
    vi.stubEnv("APP_URL", "");
    await sendActivationEmail("user@x.test", "Alice", "TOK");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.html).toContain("https://app.test.example/activate?token=TOK");
  });

  it("both unset → literal fallback 'https://app.anutech.in'", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    await sendActivationEmail("user@x.test", "Alice", "TOK");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.html).toContain("https://app.anutech.in/activate?token=TOK");
  });

  it("token + userName both rendered into the HTML body", async () => {
    await sendActivationEmail("user@x.test", "Alice", "TOK_ABC");
    const [opts] = sendEmailMock.mock.calls[0];
    expect(opts.html).toContain("Alice");
    expect(opts.html).toContain("TOK_ABC");
  });
});
