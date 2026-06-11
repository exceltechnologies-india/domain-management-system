/**
 * Tests for `app/api/auth/totp/disable/route.ts` (slice 7hb, part
 * 2). User disables 2FA. Requires BOTH the current password AND
 * a current TOTP code (or backup code).
 *
 * Threat model:
 *  - A stolen TOTP code alone (e.g. shoulder-surf, replay) must
 *    NOT be enough to disable 2FA — pinned via password-first
 *    verification
 *  - A stolen password alone (e.g. credential stuffing) must NOT
 *    be enough either — pinned via TOTP-or-backup-code requirement
 *
 * Pins:
 *  - Auth gate → 401
 *  - zod: code 6-64 chars (allows 6-digit TOTP and 12-32 char
 *    backup codes); password 1-256 chars
 *  - getUserWithTOTPSecrets null → 404
 *  - **Not-enabled guard**: dbUser.totpEnabled falsy → 400 '2FA
 *    is not enabled' (no disable side-effect possible)
 *  - **Password FIRST**: comparePassword false → 422 'Incorrect
 *    password'. TOTP / backup code NOT checked. Pinned to confirm
 *    ordering — a stolen TOTP alone can't probe whether disable
 *    succeeded.
 *  - TOTP verification: verifyTotpCode(secret, code) true →
 *    proceeds; false → fall through to backup-code check
 *  - **Backup-code loop**: iterates `totpBackupCodes` hashes
 *    calling verifyBackupCode(code, hash); first match wins;
 *    none match → 422 'Invalid authenticator code'
 *  - Happy path: disableTOTPForUser(user._id) called; 200
 *    { success: true }
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const disableTOTPForUser = vi.hoisted(() => vi.fn());
const getUserWithTOTPSecrets = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  disableTOTPForUser,
  getUserWithTOTPSecrets,
}));

const verifyTotpCode = vi.hoisted(() => vi.fn());
const verifyBackupCode = vi.hoisted(() => vi.fn());
vi.mock("@/lib/totp", () => ({ verifyTotpCode, verifyBackupCode }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/auth/totp/disable/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/auth/totp/disable", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const user = { _id: "U1", email: "alice@example.com" };

function dbUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: "U1",
    email: "alice@example.com",
    totpEnabled: true,
    totpSecret: "BASE32_ACTIVE",
    totpBackupCodes: ["HASH_BACKUP_1", "HASH_BACKUP_2"],
    comparePassword: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

const validBody = { code: "123456", password: "CurrentPass1!" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  disableTOTPForUser.mockReset().mockResolvedValue(undefined);
  getUserWithTOTPSecrets.mockReset();
  verifyTotpCode.mockReset();
  verifyBackupCode.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401; NO further work", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(401);
    expect(getUserWithTOTPSecrets).not.toHaveBeenCalled();
  });
});

describe("Body validation", () => {
  it("missing code → 400", async () => {
    const res = await POST(makeReq({ password: "x" }));
    expect(res.status).toBe(400);
  });

  it("missing password → 400", async () => {
    const res = await POST(makeReq({ code: "123456" }));
    expect(res.status).toBe(400);
  });

  it("code < 6 chars → 400", async () => {
    const res = await POST(makeReq({ code: "12345", password: "x" }));
    expect(res.status).toBe(400);
  });

  it("code > 64 chars → 400 (anti-DoS via giant input)", async () => {
    const res = await POST(
      makeReq({ code: "x".repeat(65), password: "x" })
    );
    expect(res.status).toBe(400);
  });

  it("password > 256 chars → 400", async () => {
    const res = await POST(
      makeReq({ code: "123456", password: "x".repeat(257) })
    );
    expect(res.status).toBe(400);
  });
});

describe("User lookup + not-enabled guard", () => {
  it("getUserWithTOTPSecrets null → 404", async () => {
    getUserWithTOTPSecrets.mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
  });

  it("totpEnabled falsy → 400 '2FA is not enabled'; NO password / TOTP check, NO disable", async () => {
    const u = dbUser({ totpEnabled: false });
    getUserWithTOTPSecrets.mockResolvedValueOnce(u);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not enabled");
    expect(u.comparePassword).not.toHaveBeenCalled();
    expect(verifyTotpCode).not.toHaveBeenCalled();
    expect(disableTOTPForUser).not.toHaveBeenCalled();
  });
});

describe("Password FIRST (stolen-TOTP defence)", () => {
  it("comparePassword false → 422 'Incorrect password'; TOTP NOT checked", async () => {
    const u = dbUser();
    u.comparePassword = vi.fn().mockResolvedValue(false);
    getUserWithTOTPSecrets.mockResolvedValueOnce(u);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Incorrect password");
    expect(u.comparePassword).toHaveBeenCalledWith("CurrentPass1!");
    expect(verifyTotpCode).not.toHaveBeenCalled();
    expect(verifyBackupCode).not.toHaveBeenCalled();
    expect(disableTOTPForUser).not.toHaveBeenCalled();
  });
});

describe("TOTP code verification (after password passes)", () => {
  it("verifyTotpCode true → disables 2FA; 200 { success:true }", async () => {
    getUserWithTOTPSecrets.mockResolvedValueOnce(dbUser());
    verifyTotpCode.mockReturnValueOnce(true);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(disableTOTPForUser).toHaveBeenCalledWith("U1");
    // backup-code loop should NOT have run (TOTP matched)
    expect(verifyBackupCode).not.toHaveBeenCalled();
  });

  it("verifyTotpCode called with (totpSecret, code)", async () => {
    getUserWithTOTPSecrets.mockResolvedValueOnce(dbUser());
    verifyTotpCode.mockReturnValueOnce(true);
    await POST(makeReq({ code: "654321", password: "CurrentPass1!" }));
    expect(verifyTotpCode).toHaveBeenCalledWith(
      "BASE32_ACTIVE",
      "654321"
    );
  });
});

describe("Backup-code fallback when TOTP fails", () => {
  it("TOTP fails + matching backup code → disables 2FA", async () => {
    getUserWithTOTPSecrets.mockResolvedValueOnce(
      dbUser({
        totpBackupCodes: ["HASH_A", "HASH_TARGET", "HASH_C"],
      })
    );
    verifyTotpCode.mockReturnValueOnce(false);
    // First two hashes don't match, third does
    verifyBackupCode
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false); // shouldn't be reached

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(disableTOTPForUser).toHaveBeenCalledWith("U1");
    // Loop stops at first match — only 2 calls
    expect(verifyBackupCode).toHaveBeenCalledTimes(2);
  });

  it("TOTP fails + NO backup codes registered → 422 'Invalid authenticator code'", async () => {
    getUserWithTOTPSecrets.mockResolvedValueOnce(
      dbUser({ totpBackupCodes: [] })
    );
    verifyTotpCode.mockReturnValueOnce(false);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(422);
    expect(disableTOTPForUser).not.toHaveBeenCalled();
  });

  it("TOTP fails + backup codes all reject → 422", async () => {
    getUserWithTOTPSecrets.mockResolvedValueOnce(
      dbUser({ totpBackupCodes: ["H1", "H2", "H3"] })
    );
    verifyTotpCode.mockReturnValueOnce(false);
    verifyBackupCode.mockResolvedValue(false); // never matches

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(422);
    expect(verifyBackupCode).toHaveBeenCalledTimes(3);
    expect(disableTOTPForUser).not.toHaveBeenCalled();
  });

  it("totpSecret undefined falls straight to backup-code loop (legacy users mid-migration)", async () => {
    getUserWithTOTPSecrets.mockResolvedValueOnce(
      dbUser({
        totpSecret: undefined,
        totpBackupCodes: ["HMATCH"],
      })
    );
    verifyBackupCode.mockResolvedValueOnce(true);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    // TOTP path skipped because totpSecret is undefined (short-circuited)
    expect(verifyTotpCode).not.toHaveBeenCalled();
    expect(disableTOTPForUser).toHaveBeenCalled();
  });
});
