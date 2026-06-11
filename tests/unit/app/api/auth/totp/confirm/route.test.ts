/**
 * Tests for `app/api/auth/totp/confirm/route.ts` (slice 7hb, part
 * 1). User confirms their initial 2FA enrollment by typing the
 * first code their authenticator app shows. Success activates
 * 2FA and returns 8 one-time backup codes.
 *
 * Pins:
 *  - Auth → 401 'Unauthorized'
 *  - zod code regex: ^\d{6,8}$ — non-numeric / wrong length → 400
 *  - getUserWithPendingTOTP null → 404 'User not found'
 *  - **Already-enabled guard**: dbUser.totpEnabled → 409 '2FA is
 *    already enabled' (anti-double-activation; pinned with no
 *    activation side-effect)
 *  - **No pending secret guard**: !dbUser.totpSecretPending → 400
 *    'No pending 2FA setup found. Please start setup again.'
 *    (covers the case where /confirm is called without prior
 *    /setup — the user can't bind a secret without going through
 *    the QR-issuance step)
 *  - verifyTotpCode(secret, code) false → 422 'Invalid code'
 *    (different from 400 — 422 means "request was well-formed
 *    but semantically wrong")
 *  - **Happy path**: generateBackupCodes(8) → 8 plaintext codes;
 *    hashBackupCode called on EACH; activateTOTPForUser called
 *    with (user._id, { secret: pending, hashedBackupCodes });
 *    response carries the PLAINTEXT codes (shown once, never
 *    stored in plaintext). Critical pin: the plaintext codes
 *    must reach the response while the hashed codes go to the DB.
 *  - **Negative pin**: response must NOT include the secret or
 *    the hashed codes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const activateTOTPForUser = vi.hoisted(() => vi.fn());
const getUserWithPendingTOTP = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  activateTOTPForUser,
  getUserWithPendingTOTP,
}));

const verifyTotpCode = vi.hoisted(() => vi.fn());
const generateBackupCodes = vi.hoisted(() => vi.fn());
const hashBackupCode = vi.hoisted(() => vi.fn());
vi.mock("@/lib/totp", () => ({
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCode,
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/auth/totp/confirm/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/auth/totp/confirm", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  activateTOTPForUser.mockReset().mockResolvedValue(undefined);
  getUserWithPendingTOTP.mockReset();
  verifyTotpCode.mockReset();
  generateBackupCodes.mockReset();
  hashBackupCode.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401; NO further calls", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ code: "123456" }));
    expect(res.status).toBe(401);
    expect(getUserWithPendingTOTP).not.toHaveBeenCalled();
  });
});

describe("Body validation (6-8 digit code)", () => {
  it("missing code → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("non-numeric code → 400", async () => {
    const res = await POST(makeReq({ code: "abc123" }));
    expect(res.status).toBe(400);
  });

  it("5-digit code → 400 (regex requires 6-8)", async () => {
    const res = await POST(makeReq({ code: "12345" }));
    expect(res.status).toBe(400);
  });

  it("9-digit code → 400", async () => {
    const res = await POST(makeReq({ code: "123456789" }));
    expect(res.status).toBe(400);
  });

  it("8-digit code accepted by schema (some apps emit 8 digits)", async () => {
    getUserWithPendingTOTP.mockResolvedValueOnce({
      _id: "U1",
      totpEnabled: false,
      totpSecretPending: "BASE32",
    });
    verifyTotpCode.mockReturnValueOnce(true);
    generateBackupCodes.mockReturnValueOnce(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
    hashBackupCode.mockImplementation(async (c: string) => `H_${c}`);

    const res = await POST(makeReq({ code: "12345678" }));
    expect(res.status).toBe(200);
  });
});

describe("User lookup", () => {
  it("getUserWithPendingTOTP null → 404 'User not found'", async () => {
    getUserWithPendingTOTP.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ code: "123456" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("User not found");
  });
});

describe("Already-enabled guard (409)", () => {
  it("totpEnabled → 409 '2FA is already enabled'; NO activation side-effects", async () => {
    getUserWithPendingTOTP.mockResolvedValueOnce({
      _id: "U1",
      totpEnabled: true,
      totpSecretPending: "BASE32",
    });
    const res = await POST(makeReq({ code: "123456" }));
    expect(res.status).toBe(409);
    expect(verifyTotpCode).not.toHaveBeenCalled();
    expect(activateTOTPForUser).not.toHaveBeenCalled();
  });
});

describe("No pending secret guard (400)", () => {
  it("missing totpSecretPending → 400 'No pending 2FA setup found'; NO verify, NO activation", async () => {
    getUserWithPendingTOTP.mockResolvedValueOnce({
      _id: "U1",
      totpEnabled: false,
      // No totpSecretPending
    });
    const res = await POST(makeReq({ code: "123456" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("No pending 2FA setup");
    expect(verifyTotpCode).not.toHaveBeenCalled();
  });
});

describe("Invalid code (422)", () => {
  it("verifyTotpCode false → 422 'Invalid code'; NO activation", async () => {
    getUserWithPendingTOTP.mockResolvedValueOnce({
      _id: "U1",
      totpEnabled: false,
      totpSecretPending: "BASE32_PENDING",
    });
    verifyTotpCode.mockReturnValueOnce(false);

    const res = await POST(makeReq({ code: "999999" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("Invalid code");
    expect(activateTOTPForUser).not.toHaveBeenCalled();
  });

  it("verifyTotpCode called with (pendingSecret, code)", async () => {
    getUserWithPendingTOTP.mockResolvedValueOnce({
      _id: "U1",
      totpEnabled: false,
      totpSecretPending: "PENDING_SECRET_XYZ",
    });
    verifyTotpCode.mockReturnValueOnce(false);
    await POST(makeReq({ code: "111111" }));
    expect(verifyTotpCode).toHaveBeenCalledWith(
      "PENDING_SECRET_XYZ",
      "111111"
    );
  });
});

describe("Happy path — activation + backup codes", () => {
  it("generates 8 codes, hashes EACH, activates with (secret + hashed codes); response carries PLAINTEXT codes", async () => {
    getUserWithPendingTOTP.mockResolvedValueOnce({
      _id: "U1",
      totpEnabled: false,
      totpSecretPending: "PENDING_SECRET_XYZ",
    });
    verifyTotpCode.mockReturnValueOnce(true);
    const plaintext = [
      "abc-001", "abc-002", "abc-003", "abc-004",
      "abc-005", "abc-006", "abc-007", "abc-008",
    ];
    generateBackupCodes.mockReturnValueOnce(plaintext);
    hashBackupCode.mockImplementation(async (c: string) => `H_${c}`);

    const res = await POST(makeReq({ code: "123456" }));
    expect(res.status).toBe(200);

    // Pipeline shape
    expect(generateBackupCodes).toHaveBeenCalledWith(8);
    expect(hashBackupCode).toHaveBeenCalledTimes(8);
    expect(activateTOTPForUser).toHaveBeenCalledWith("U1", {
      secret: "PENDING_SECRET_XYZ",
      hashedBackupCodes: plaintext.map((c) => `H_${c}`),
    });

    // Response: plaintext codes ONLY (DB receives hashed)
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.backupCodes).toEqual(plaintext);
  });

  it("NEGATIVE leak guard: response must NOT include the secret or the hashed codes", async () => {
    getUserWithPendingTOTP.mockResolvedValueOnce({
      _id: "U1",
      totpEnabled: false,
      totpSecretPending: "JBSWY3DPEHPK3PXP_SECRET_LEAK_ME",
    });
    verifyTotpCode.mockReturnValueOnce(true);
    generateBackupCodes.mockReturnValueOnce(["c1"]);
    hashBackupCode.mockImplementation(async (c: string) => `HASH_OF_${c}_LEAK_ME`);

    const body = await (await POST(makeReq({ code: "123456" }))).json();
    const json = JSON.stringify(body);
    expect(json).not.toContain("JBSWY3DPEHPK3PXP");
    expect(json).not.toContain("HASH_OF_");
    expect(json).not.toContain("LEAK_ME");
  });
});
