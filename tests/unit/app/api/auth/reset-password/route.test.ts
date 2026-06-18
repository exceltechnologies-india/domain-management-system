/**
 * Tests for `app/api/auth/reset-password/route.ts` (slice 7hf,
 * part 1). Public "forgot my password" completion flow — user
 * submits the token from their reset email plus a new password.
 *
 * The route is defense-in-depth: five distinct security layers
 * must all pass before any DB mutation happens.
 *
 * Pins (in order — layer N runs only if N-1 passed):
 *  - **Layer 1 — CSRF**: SecurityValidator.validateCSRF →
 *    invalid → 403 CSRF_ERROR with the validator's error message
 *  - **Layer 2 — zod**: Schemas.resetPassword.safeParse →
 *    invalid → 400 VALIDATION_ERROR with first error message
 *  - **Layer 4 — Token verification**: findUserByResetToken null
 *    → 400 INVALID_TOKEN 'Invalid or expired reset token'
 *  - **Layer 5 — CRITICAL: Admin block**: user.role === 'admin'
 *    → 403 UNAUTHORIZED 'Admin password reset is not allowed
 *    through this method'. Pinned because admins MUST go through
 *    the step-up-auth admin reset flow (slice 7gx); allowing
 *    them through the public flow would bypass the password re-
 *    auth requirement.
 *  - **Token clearing**: user.password set; resetToken AND
 *    resetTokenExpiry both set to undefined BEFORE save (used
 *    reset link cannot be replayed)
 *  - **Audit notification**: EmailService.sendPasswordChange-
 *    NotificationEmail invoked (failure swallowed via .catch);
 *    customer gets a security alert
 *  - Outer catch → 500 SERVER_ERROR 'Reset password failed'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const validateCSRF = vi.hoisted(() => vi.fn());
vi.mock("@/lib/security", () => ({
  SecurityValidator: { validateCSRF },
}));

const findUserByResetToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ findUserByResetToken }));

const sendPasswordChangeNotificationEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendPasswordChangeNotificationEmail },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/auth/reset-password/route";

function makeReq(
  body: unknown,
  headers: Record<string, string> = {}
) {
  return new NextRequest("https://example.com/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const validBody = {
  token: "reset-token-fake-123",
  password: "StrongP@ssw0rd123!",
};

function freshUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: "U1",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Anderson",
    role: "user",
    password: "$2a$old-hash",
    resetToken: "reset-token-fake-123",
    resetTokenExpiry: new Date("2026-06-12"),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  validateCSRF.mockReset().mockReturnValue({ isValid: true });
  findUserByResetToken.mockReset();
  sendPasswordChangeNotificationEmail.mockReset().mockResolvedValue(undefined);
});

// ─── Layer 1: CSRF ────────────────────────────────────────────────
describe("Layer 1 — CSRF protection", () => {
  it("invalid CSRF → 403 CSRF_ERROR; NO body parse, NO downstream layers", async () => {
    validateCSRF.mockReturnValueOnce({
      isValid: false,
      error: "Origin mismatch",
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("CSRF_ERROR");
    expect(body.error).toBe("Origin mismatch");
    expect(findUserByResetToken).not.toHaveBeenCalled();
  });

  it("invalid CSRF with no error message → falls back to 'CSRF Validation Failed'", async () => {
    validateCSRF.mockReturnValueOnce({ isValid: false });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("CSRF Validation Failed");
  });
});

// ─── Layer 2: zod ────────────────────────────────────────────────
describe("Layer 2 — zod validation", () => {
  it("missing token → 400 VALIDATION_ERROR", async () => {
    const res = await POST(
      makeReq({
        password: "StrongP@ssw0rd123!",
      })
    );
    expect(res.status).toBe(400);
  });

  it("weak password fails schema → 400", async () => {
    const res = await POST(
      makeReq({
        ...validBody,
        password: "weak",
      })
    );
    expect(res.status).toBe(400);
  });
});

// ─── Layer 4: token verification ─────────────────────────────────
describe("Layer 4 — token verification", () => {
  it("findUserByResetToken null → 400 INVALID_TOKEN 'Invalid or expired reset token'", async () => {
    findUserByResetToken.mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_TOKEN");
    expect(body.error).toBe("Invalid or expired reset token");
  });
});

// ─── Layer 5: admin block (CRITICAL) ─────────────────────────────
describe("Layer 5 — CRITICAL admin block", () => {
  it("user.role === 'admin' → 403 UNAUTHORIZED 'Admin password reset is not allowed through this method'; NO save, NO email", async () => {
    const admin = freshUser({ role: "admin" });
    findUserByResetToken.mockResolvedValueOnce(admin);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.error).toContain("Admin password reset");
    expect(admin.save).not.toHaveBeenCalled();
    expect(sendPasswordChangeNotificationEmail).not.toHaveBeenCalled();
  });
});

// ─── Token clearing + save ───────────────────────────────────────
describe("Password update + token clearing", () => {
  it("user.password set; resetToken AND resetTokenExpiry both cleared BEFORE save; save called once", async () => {
    const captured: {
      password?: string;
      resetToken?: unknown;
      resetTokenExpiry?: unknown;
    } = {};
    const u = freshUser({
      save: vi.fn().mockImplementation(function (this: {
        password: string;
        resetToken?: string;
        resetTokenExpiry?: Date;
      }) {
        captured.password = this.password;
        captured.resetToken = this.resetToken;
        captured.resetTokenExpiry = this.resetTokenExpiry;
        return Promise.resolve();
      }),
    });
    findUserByResetToken.mockResolvedValueOnce(u);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(captured.password).toBe("StrongP@ssw0rd123!");
    expect(captured.resetToken).toBeUndefined();
    expect(captured.resetTokenExpiry).toBeUndefined();
    expect(u.save).toHaveBeenCalledTimes(1);
  });
});

// ─── Audit email ─────────────────────────────────────────────────
describe("Audit notification email", () => {
  it("sendPasswordChangeNotificationEmail called with (email, fullName, false)", async () => {
    const u = freshUser();
    findUserByResetToken.mockResolvedValueOnce(u);

    await POST(makeReq(validBody));
    expect(sendPasswordChangeNotificationEmail).toHaveBeenCalledWith(
      "alice@example.com",
      "Alice Anderson",
      false
    );
  });

  it("missing names → email falls back to user.email", async () => {
    const u = freshUser({ firstName: undefined, lastName: undefined });
    findUserByResetToken.mockResolvedValueOnce(u);

    await POST(makeReq(validBody));
    expect(sendPasswordChangeNotificationEmail).toHaveBeenCalledWith(
      "alice@example.com",
      "alice@example.com",
      false
    );
  });

  it("email send failure SWALLOWED — password reset still succeeds", async () => {
    const u = freshUser();
    findUserByResetToken.mockResolvedValueOnce(u);
    sendPasswordChangeNotificationEmail.mockRejectedValueOnce(
      new Error("SMTP down")
    );

    const res = await POST(makeReq(validBody));
    // Should still be 200 — the .catch() in source swallows
    expect(res.status).toBe(200);
  });
});

// ─── Success ─────────────────────────────────────────────────────
describe("Success response", () => {
  it("200 with 'Password has been reset successfully' message", async () => {
    findUserByResetToken.mockResolvedValueOnce(freshUser());
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Password has been reset successfully");
  });
});

// ─── Outer catch ─────────────────────────────────────────────────
describe("Outer catch", () => {
  it("findUserByResetToken throw → 500 SERVER_ERROR 'Reset password failed'", async () => {
    findUserByResetToken.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
    expect(body.error).toBe("Reset password failed");
  });
});
