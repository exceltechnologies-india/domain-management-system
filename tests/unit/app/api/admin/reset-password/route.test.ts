/**
 * Tests for `app/api/admin/reset-password/route.ts` (slice 7gx,
 * part 1). Admin self-resets their own password.
 *
 * Security policy: a single compromised session cookie must NOT be
 * enough to change the admin password. The route enforces step-up
 * re-authentication (require current password) before letting the
 * caller set a new one.
 *
 * Pins:
 *  - verifyAdminAuth FIRST — invalid → 401 with the auth-layer's
 *    error message
 *  - **Step-up re-auth via requireReAuth**: passed=false → 403
 *    REAUTH_REQUIRED 'Current password required to reset the admin
 *    password' (NO body parsing, NO password hash, NO save). This
 *    is the critical pin — without it, anyone with a valid session
 *    cookie could change the admin password.
 *  - zod schema: newPassword min 8 max 256, confirmPassword min 1,
 *    refine: newPassword === confirmPassword (else 'Passwords do
 *    not match')
 *  - findAnyAdmin null → 404 'Admin user not found' (defensive —
 *    if the admin row was deleted between auth and reset)
 *  - bcrypt: genSalt called with rounds=12, then hash(newPassword,
 *    salt); the hash is what gets stored
 *  - adminUser.save() called once
 *  - Success → 200 with 'reset successfully' message
 *  - Outer catch → 500 'Internal server error' generic (NO leak)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyAdminAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAuth }));

const requireReAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-security", () => ({ requireReAuth }));

const findAnyAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ findAnyAdmin }));

const genSalt = vi.hoisted(() => vi.fn());
const hash = vi.hoisted(() => vi.fn());
vi.mock("bcryptjs", () => ({
  default: { genSalt, hash },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/reset-password/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/admin/reset-password", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const validBody = {
  newPassword: "NewStr0ng!Pass",
  confirmPassword: "NewStr0ng!Pass",
};

const validAdmin = { id: "ADMIN_1", email: "admin@example.com" };

beforeEach(() => {
  verifyAdminAuth.mockReset().mockResolvedValue({ valid: true, user: validAdmin });
  requireReAuth.mockReset().mockResolvedValue({ passed: true });
  findAnyAdmin.mockReset();
  genSalt.mockReset().mockResolvedValue("SALT_FAKE");
  hash.mockReset().mockResolvedValue("HASH_FAKE");
});

describe("verifyAdminAuth gate", () => {
  it("invalid auth → 401 with auth-layer error message", async () => {
    verifyAdminAuth.mockResolvedValueOnce({
      valid: false,
      error: "Session expired",
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Session expired");
    expect(requireReAuth).not.toHaveBeenCalled();
    expect(findAnyAdmin).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });
});

describe("Step-up re-auth (CRITICAL)", () => {
  it("requireReAuth passed=false → 403 REAUTH_REQUIRED; NO body parsing, NO password hash, NO save", async () => {
    requireReAuth.mockResolvedValueOnce({ passed: false });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("REAUTH_REQUIRED");
    expect(body.error).toContain("Current password required");
    expect(findAnyAdmin).not.toHaveBeenCalled();
    expect(genSalt).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it("requireReAuth called with (request, authResult.user.id) — current admin's id pinned", async () => {
    await POST(makeReq(validBody));
    expect(requireReAuth).toHaveBeenCalledWith(
      expect.any(Object),
      "ADMIN_1"
    );
  });
});

describe("Body validation (only AFTER auth + re-auth)", () => {
  it("password < 8 chars → 400 VALIDATION_ERROR", async () => {
    const res = await POST(
      makeReq({ newPassword: "short", confirmPassword: "short" })
    );
    expect(res.status).toBe(400);
    expect(findAnyAdmin).not.toHaveBeenCalled();
  });

  it("password > 256 chars → 400", async () => {
    const tooLong = "A1!" + "a".repeat(256);
    const res = await POST(
      makeReq({ newPassword: tooLong, confirmPassword: tooLong })
    );
    expect(res.status).toBe(400);
  });

  it("newPassword !== confirmPassword → 400 'Passwords do not match'", async () => {
    const res = await POST(
      makeReq({
        newPassword: "ValidP@ss1",
        confirmPassword: "DifferentP@ss1",
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("do not match");
  });
});

describe("Admin lookup", () => {
  it("findAnyAdmin null → 404 'Admin user not found' (defensive — admin row deleted between auth and reset)", async () => {
    findAnyAdmin.mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Admin user not found");
    expect(hash).not.toHaveBeenCalled();
  });
});

describe("bcrypt hashing", () => {
  it("genSalt called with rounds=12; hash(newPassword, salt) is what gets stored", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    findAnyAdmin.mockResolvedValueOnce({
      _id: "ADMIN_1",
      email: "admin@example.com",
      password: "OLD_HASH",
      save,
    });

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);

    expect(genSalt).toHaveBeenCalledWith(12);
    expect(hash).toHaveBeenCalledWith("NewStr0ng!Pass", "SALT_FAKE");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("admin.password updated to the hash (NOT the plaintext)", async () => {
    const captured: { password?: string } = {};
    const save = vi.fn().mockImplementation(function (this: { password: string }) {
      captured.password = this.password;
      return Promise.resolve();
    });
    findAnyAdmin.mockResolvedValueOnce({
      _id: "ADMIN_1",
      password: "OLD_HASH",
      save,
    });
    hash.mockResolvedValueOnce("BCRYPT_HASH_OF_NEW_PASSWORD");

    await POST(makeReq(validBody));
    expect(captured.password).toBe("BCRYPT_HASH_OF_NEW_PASSWORD");
    expect(captured.password).not.toBe("NewStr0ng!Pass");
  });
});

describe("Success response", () => {
  it("200 with 'reset successfully' message", async () => {
    findAnyAdmin.mockResolvedValueOnce({
      _id: "ADMIN_1",
      password: "OLD",
      save: vi.fn().mockResolvedValue(undefined),
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("reset successfully");
  });
});

describe("Outer catch", () => {
  it("findAnyAdmin throw → 500 'Internal server error' (no leak)", async () => {
    findAnyAdmin.mockRejectedValueOnce(
      new Error("Mongo: shard-1 connection refused")
    );
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("Mongo");
  });
});
