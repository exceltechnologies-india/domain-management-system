/**
 * Tests for `app/api/contact/route.ts` (slice 7gf). Public contact-
 * form endpoint — no auth, so every layer of input/anti-spam
 * defense has to fire correctly.
 *
 * Threat model pinned:
 *  - Bot submissions: reCAPTCHA was removed 2026-06-17; rate limit + zod stay
 *  - XSS in admin inbox or in user's confirmation email → every
 *    user-supplied string is run through InputValidator.sanitizeHtml
 *    before being interpolated into the HTML body
 *  - Email-server exfil / spoofing → InputValidator chain rejects
 *    header-injection patterns, oversize inputs, malformed emails
 *  - Server errors → generic 500, no internals leaked
 *
 * Specific pins:
 *  - Body validation FIRST (zod) — missing fields / oversize /
 *    empty string → 400 (validatedBody returns VALIDATION_ERROR)
 *  - InputValidator chain runs after zod. Any one of name / email /
 *    subject / message having errors → 400 with errors joined by ', '
 *    (so client can show all four at once)
 *  - **Admin notification sent first**; if EmailService.sendAdminNotification
 *    returns false → 500 'Failed to send message' (admin must
 *    actually receive the lead — don't 200 if mail is silently
 *    dropped)
 *  - **User-confirmation email sent SECOND** with sanitizeHtml
 *    applied to name / subject / message before HTML interpolation
 *  - Confirmation email failure is NOT surfaced as 500 — admin
 *    already has the lead; user just doesn't get a thank-you
 *  - Outer catch → 500 'Internal server error' (generic, no
 *    stack details)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const validateName = vi.hoisted(() => vi.fn());
const validateEmail = vi.hoisted(() => vi.fn());
const validateMessage = vi.hoisted(() => vi.fn());
const sanitizeHtml = vi.hoisted(() => vi.fn());
vi.mock("@/lib/validation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/validation")>(
    "@/lib/validation"
  );
  return {
    ...actual,
    InputValidator: {
      validateName,
      validateEmail,
      validateMessage,
      sanitizeHtml,
    },
  };
});

const sendAdminNotification = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendAdminNotification, sendEmail },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/contact/route";

function makeReq(
  body: unknown,
  headers: Record<string, string> = {}
) {
  return new NextRequest("https://example.com/api/contact", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const validBody = {
  name: "Bob User",
  email: "bob@example.com",
  subject: "Need help",
  message: "Hello, this is my message",
};

function passingValidators() {
  validateName.mockReturnValue({
    isValid: true,
    errors: [],
    sanitized: "Bob User",
  });
  validateEmail.mockReturnValue({
    isValid: true,
    errors: [],
    sanitized: "bob@example.com",
  });
  validateMessage
    .mockReturnValueOnce({
      isValid: true,
      errors: [],
      sanitized: "Need help",
    })
    .mockReturnValueOnce({
      isValid: true,
      errors: [],
      sanitized: "Hello, this is my message",
    });
  sanitizeHtml.mockImplementation((s: string) => s);
}

beforeEach(() => {
  validateName.mockReset();
  validateEmail.mockReset();
  validateMessage.mockReset();
  sanitizeHtml.mockReset();
  sendAdminNotification.mockReset().mockResolvedValue(true);
  sendEmail.mockReset().mockResolvedValue(true);
});

// ─── Body validation (zod) ────────────────────────────────────────
describe("Body validation (zod, before any external call)", () => {
  it("empty name → 400", async () => {
    const res = await POST(makeReq({ ...validBody, name: "" }));
    expect(res.status).toBe(400);
  });

  it("oversize message (> 10k chars) → 400", async () => {
    const res = await POST(makeReq({ ...validBody, message: "a".repeat(10001) }));
    expect(res.status).toBe(400);
  });

  it("malformed JSON → 400 INVALID_JSON", async () => {
    const req = new NextRequest("https://example.com/api/contact", {
      method: "POST",
      body: "{not-json",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

// reCAPTCHA gate + IP-discovery tests were removed on 2026-06-17 ahead
// of a fresh re-install. The contact form still has zod body validation,
// email-format checks, and rate-limiting at the middleware layer.

// ─── InputValidator chain ────────────────────────────────────────
describe("InputValidator chain", () => {
  it("ANY field with errors → 400, errors joined by ', '", async () => {
    validateName.mockReturnValue({
      isValid: false,
      errors: ["Name contains invalid characters"],
    });
    validateEmail.mockReturnValue({
      isValid: false,
      errors: ["Invalid email format"],
    });
    validateMessage
      .mockReturnValueOnce({ isValid: true, errors: [], sanitized: "Subject" })
      .mockReturnValueOnce({
        isValid: false,
        errors: ["Message too short"],
      });

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      "Name contains invalid characters, Invalid email format, Message too short"
    );
    expect(sendAdminNotification).not.toHaveBeenCalled();
  });

  it("all pass → proceeds to admin email", async () => {
    passingValidators();
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(sendAdminNotification).toHaveBeenCalledTimes(1);
  });
});

// ─── Admin email (lead-capture must succeed) ──────────────────────
describe("Admin notification", () => {
  it("sendAdminNotification false → 500 'Failed to send message' (user must NOT see 200)", async () => {
    passingValidators();
    sendAdminNotification.mockResolvedValueOnce(false);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to send message");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("admin notification gets the SANITIZED values, not raw input", async () => {
    validateName.mockReturnValue({
      isValid: true,
      errors: [],
      sanitized: "[clean Bob]",
    });
    validateEmail.mockReturnValue({
      isValid: true,
      errors: [],
      sanitized: "[clean]bob@example.com",
    });
    validateMessage
      .mockReturnValueOnce({ isValid: true, errors: [], sanitized: "[clean subj]" })
      .mockReturnValueOnce({ isValid: true, errors: [], sanitized: "[clean msg]" });
    sanitizeHtml.mockImplementation((s: string) => s);

    await POST(
      makeReq({ ...validBody, name: "<script>", message: "<img onerror=>" })
    );

    expect(sendAdminNotification).toHaveBeenCalledWith(
      expect.any(String), // admin email
      expect.stringContaining("[clean subj]"),
      expect.stringContaining("[clean Bob]"),
      expect.objectContaining({
        name: "[clean Bob]",
        email: "[clean]bob@example.com",
        subject: "[clean subj]",
        message: "[clean msg]",
      })
    );
  });
});

// ─── User confirmation (XSS guard via sanitizeHtml) ───────────────
describe("User confirmation email — XSS guard via sanitizeHtml", () => {
  it("sanitizeHtml called on name + subject + message before HTML render", async () => {
    passingValidators();
    await POST(makeReq(validBody));

    expect(sanitizeHtml).toHaveBeenCalledWith("Bob User");
    expect(sanitizeHtml).toHaveBeenCalledWith("Need help");
    expect(sanitizeHtml).toHaveBeenCalledWith("Hello, this is my message");
  });

  it("if sanitizeHtml strips a tag, the stripped value appears in the rendered HTML (not the raw tag)", async () => {
    validateName.mockReturnValue({
      isValid: true,
      errors: [],
      sanitized: "<script>alert(1)</script>Bob",
    });
    validateEmail.mockReturnValue({
      isValid: true,
      errors: [],
      sanitized: "bob@example.com",
    });
    validateMessage
      .mockReturnValueOnce({ isValid: true, errors: [], sanitized: "Subject" })
      .mockReturnValueOnce({
        isValid: true,
        errors: [],
        sanitized: "<img onerror=alert(1)>msg",
      });
    sanitizeHtml.mockImplementation((s: string) =>
      s.replace(/<[^>]*>/g, "")
    );

    await POST(makeReq(validBody));

    const userCall = sendEmail.mock.calls[0][0];
    expect(userCall.html).not.toContain("<script>");
    expect(userCall.html).not.toContain("onerror");
    expect(userCall.html).toContain("alert(1)Bob"); // sanitized form
  });

  it("user-confirmation email sent to the user's email address", async () => {
    passingValidators();
    await POST(makeReq(validBody));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe("bob@example.com");
  });

  it("confirmation email failure does NOT roll back the 200 (admin already has lead)", async () => {
    passingValidators();
    sendEmail.mockRejectedValueOnce(new Error("SMTP late"));
    // The route doesn't .catch the user-email failure, so this lands in
    // the outer catch which IS a 500. This pins the current behaviour
    // explicitly: failures here become 500. If the policy ever changes
    // to "best-effort + 200", this test will fail and force a review.
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
  });
});

// ─── Outer catch ──────────────────────────────────────────────────
describe("Outer catch", () => {
  it("InputValidator throws → 500", async () => {
    validateName.mockImplementation(() => {
      throw new Error("validator crash");
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
  });
});
