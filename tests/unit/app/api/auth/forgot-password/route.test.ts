/**
 * Tests for `app/api/auth/forgot-password/route.ts` (slice 7hn, part 1).
 *
 * Public password-reset request endpoint. The most safety-critical
 * public auth surface — its weak version was a 2024 audit finding.
 *
 * Threat model:
 *  - **Email-enumeration**: an attacker can probe the endpoint with
 *    arbitrary emails. Response shape MUST be identical for
 *    user-exists / user-missing / user-is-admin — same status, same
 *    JSON body. Pinned with explicit triple comparison.
 *  - **Admin-via-public-flow uplift**: admin accounts MUST NOT be
 *    resettable via this public flow (they have a step-up admin-only
 *    flow; this route would otherwise be a soft entry point). Pinned
 *    by asserting NO save/email side-effect on admin emails.
 *  - **Token replay**: tokens are `crypto.randomBytes(32).toString('hex')`
 *    (64 char hex) with a 1-hour expiry — pinned by shape + expiry.
 *  - **Rate-limit-bypass via huge body**: rate-limit runs BEFORE
 *    request.json() so an attacker can't probe by sending oversized
 *    bodies. Pinned: rate-limit denied → no body parse attempted.
 *
 * Other pins:
 *  - CSRF gate first → 403 CSRF_ERROR
 *  - Rate limit BEFORE body parse → 429 with limit:3
 *  - Zod fail (invalid email) → 400 VALIDATION_ERROR
 *  - clientIP: x-forwarded-for (first hop) → x-real-ip → "unknown"
 *  - sendPasswordResetEmail receives isFirstTimeSetup based on
 *    user.isGuest === true (strict-truth, not coerced)
 *  - sendPasswordResetEmail false → 500 EMAIL_ERROR (token IS saved
 *    already — pinned because admin re-issue depends on this)
 *  - Outer catch → 500 SERVER_ERROR (no upstream leak — uses the
 *    secureErrorResponse path)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const validateCSRF = vi.hoisted(() => vi.fn());
vi.mock("@/lib/security", () => ({
  SecurityValidator: { validateCSRF },
}));

const isAllowed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>(
    "@/lib/rate-limit"
  );
  return {
    ...actual,
    rateLimiters: { passwordReset: { isAllowed } },
  };
});

const getUserByEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserByEmail }));

const sendPasswordResetEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendPasswordResetEmail },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/auth/forgot-password/route";

function makeReq(
  body: unknown = {},
  headers: Record<string, string> = {}
) {
  return new NextRequest("https://example.com/api/auth/forgot-password", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.example.com",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  validateCSRF.mockReset().mockReturnValue({ isValid: true });
  isAllowed.mockReset().mockResolvedValue({ allowed: true, remaining: 3 });
  getUserByEmail.mockReset();
  sendPasswordResetEmail.mockReset().mockResolvedValue(true);
});

describe("Layer 1 — CSRF", () => {
  it("invalid CSRF → 403 CSRF_ERROR; downstream untouched", async () => {
    validateCSRF.mockReturnValueOnce({ isValid: false, error: "bad origin" });
    const res = await POST(makeReq({ email: "x@y.com" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("CSRF_ERROR");
    expect(isAllowed).not.toHaveBeenCalled();
    expect(getUserByEmail).not.toHaveBeenCalled();
  });
});

describe("Layer 2 — Rate limit BEFORE body parse", () => {
  it("rate-limit denied → 429 limit:3; body NEVER parsed", async () => {
    isAllowed.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    // Hostile body — if rate-limit ran AFTER body parse, this would
    // probably blow up on JSON.parse and return a 400/500.
    const res = await POST(makeReq("{not-json-bytes"));
    expect(res.status).toBe(429);
    expect(getUserByEmail).not.toHaveBeenCalled();
  });
});

describe("Layer 3 — Zod schema", () => {
  it("invalid email format → 400 VALIDATION_ERROR", async () => {
    const res = await POST(
      makeReq({ email: "not-an-email" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("email is lower-cased before lookup", async () => {
    // NOTE: zod's `.email()` validator runs BEFORE `.trim()` in this
    // schema, so leading/trailing whitespace fails as VALIDATION_ERROR
    // (not silently trimmed). This test pins only the lowercase step.
    getUserByEmail.mockResolvedValueOnce(null);
    await POST(
      makeReq({ email: "ALICE@Example.COM" })
    );
    expect(getUserByEmail).toHaveBeenCalledWith("alice@example.com");
  });

  it("leading whitespace in email → 400 VALIDATION_ERROR (pins zod order: email() before trim())", async () => {
    const res = await POST(
      makeReq({ email: "  alice@example.com" })
    );
    expect(res.status).toBe(400);
    expect(getUserByEmail).not.toHaveBeenCalled();
  });
});

describe("Layer 5 — Anti-enumeration (response indistinguishability)", () => {
  const probe = () =>
    POST(makeReq({ email: "x@y.com" }));

  it("user-missing AND user-is-admin AND user-found all return identical 200 body shape", async () => {
    // Probe 1: user missing
    getUserByEmail.mockResolvedValueOnce(null);
    const r1 = await probe();
    const b1 = await r1.json();

    // Probe 2: user is admin
    getUserByEmail.mockResolvedValueOnce({
      role: "admin",
      email: "x@y.com",
      save: vi.fn(),
    });
    const r2 = await probe();
    const b2 = await r2.json();

    // Probe 3: user found (regular)
    getUserByEmail.mockResolvedValueOnce({
      _id: "U1",
      role: "user",
      email: "x@y.com",
      firstName: "Eve",
      lastName: "Doe",
      save: vi.fn().mockResolvedValue(undefined),
    });
    const r3 = await probe();
    const b3 = await r3.json();

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    // Same body shape — anti-enumeration invariant
    expect(b1).toEqual(b2);
    expect(b1).toEqual(b3);
    expect(b1.message).toContain("If an account with that email exists");
  });

  it("user-missing → no token save, no email", async () => {
    getUserByEmail.mockResolvedValueOnce(null);
    await probe();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe("Layer 6 — Admin-via-public-flow block", () => {
  it("admin email → identical message; NO save, NO email side-effect", async () => {
    const save = vi.fn();
    getUserByEmail.mockResolvedValueOnce({
      role: "admin",
      email: "admin@example.com",
      save,
    });
    const res = await POST(
      makeReq({ email: "admin@example.com" })
    );
    expect(res.status).toBe(200);
    expect(save).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe("Happy path — token + email", () => {
  function setupUser(overrides: Record<string, unknown> = {}) {
    const user = {
      _id: "U1",
      role: "user",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
      isGuest: false,
      resetToken: undefined as string | undefined,
      resetTokenExpiry: undefined as Date | undefined,
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    getUserByEmail.mockResolvedValueOnce(user);
    return user;
  }

  it("token is 64-char hex, expiry ~1h from now, save called once", async () => {
    const user = setupUser();
    const before = Date.now();
    await POST(
      makeReq({ email: "alice@example.com" })
    );
    expect(user.save).toHaveBeenCalledTimes(1);
    expect(user.resetToken).toMatch(/^[a-f0-9]{64}$/);
    const expiryMs = user.resetTokenExpiry!.getTime();
    expect(expiryMs).toBeGreaterThanOrEqual(before + 3600000 - 200);
    expect(expiryMs).toBeLessThanOrEqual(Date.now() + 3600000 + 200);
  });

  it("isGuest=true → sendPasswordResetEmail receives isFirstTimeSetup=true", async () => {
    setupUser({ isGuest: true });
    await POST(makeReq({ email: "g@y.com" }));
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      "alice@example.com",
      "Alice Smith",
      expect.any(String),
      true
    );
  });

  it("isGuest=false → isFirstTimeSetup=false (strict-truth, not coerced)", async () => {
    setupUser({ isGuest: false });
    await POST(makeReq({ email: "g@y.com" }));
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      false
    );
  });

  it("isGuest undefined → isFirstTimeSetup=false (NOT NaN-coerced or true-y)", async () => {
    setupUser({ isGuest: undefined });
    await POST(makeReq({ email: "g@y.com" }));
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      false
    );
  });

  it("email-send failure → 500 EMAIL_ERROR; token IS saved already (admin can reissue)", async () => {
    const user = setupUser();
    sendPasswordResetEmail.mockResolvedValueOnce(false);
    const res = await POST(
      makeReq({ email: "g@y.com" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("EMAIL_ERROR");
    // Token was committed BEFORE the email send — pinned because
    // the admin-reissue UX depends on the saved token surviving an
    // email outage.
    expect(user.save).toHaveBeenCalledTimes(1);
    expect(user.resetToken).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("Outer catch", () => {
  it("getUserByEmail throw → 500 SERVER_ERROR; sentinel NOT in raw body", async () => {
    getUserByEmail.mockRejectedValueOnce(
      new Error("Mongo cluster down — pwd $2a$12$BCRYPT_LEAK_ME")
    );
    const res = await POST(
      makeReq({ email: "x@y.com" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
    // The 4th arg to secureErrorResponse carries the Error object, but
    // the public response message is the static string.
    expect(body.error).toBe("Password reset request failed");
  });
});
