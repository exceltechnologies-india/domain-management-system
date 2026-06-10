/**
 * Tests for `app/api/auth/totp/setup/route.ts` (slice 7gy, part 1).
 * Customer 2FA enrollment — generates the QR code that the
 * authenticator app scans. The secret is stored as PENDING until
 * the user confirms it via the /confirm route, so a half-finished
 * enrollment doesn't leave the user locked out.
 *
 * GET pins:
 *  - Auth → 401 'Unauthorized'
 *  - getUserById null → 404 'User not found'
 *  - 200 with { totpEnabled } only (no other fields leak)
 *
 * POST pins:
 *  - Auth → 401
 *  - getUserById null → 404
 *  - **Already-enabled guard**: dbUser.totpEnabled → 409 'already
 *    enabled. Disable it before re-enrolling.' Pinned because
 *    without this guard a malicious request could re-issue a new
 *    TOTP secret on an active account (potential reset / takeover
 *    vector if the confirm step is reachable).
 *  - generateTotpSecret called once
 *  - getTotpUri called with (secret, dbUser.email) — email is the
 *    account label shown in the authenticator app
 *  - generateQrCodeDataUrl called with the URI
 *  - **setPendingTOTPSecret called with String(dbUser._id) and
 *    the secret** — secret stored as PENDING (not active) until
 *    /confirm verifies a real token
 *  - Response carries { qrCodeDataUrl, manualKey } only — manual
 *    key is the same secret (so users without a camera can type it)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getUserById = vi.hoisted(() => vi.fn());
const setPendingTOTPSecret = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  getUserById,
  setPendingTOTPSecret,
}));

const generateTotpSecret = vi.hoisted(() => vi.fn());
const getTotpUri = vi.hoisted(() => vi.fn());
const generateQrCodeDataUrl = vi.hoisted(() => vi.fn());
vi.mock("@/lib/totp", () => ({
  generateTotpSecret,
  getTotpUri,
  generateQrCodeDataUrl,
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/auth/totp/setup/route";

function makeReq(method: "GET" | "POST") {
  return new NextRequest("https://example.com/api/auth/totp/setup", {
    method,
  });
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  getUserById.mockReset();
  setPendingTOTPSecret.mockReset().mockResolvedValue(undefined);
  generateTotpSecret.mockReset();
  getTotpUri.mockReset();
  generateQrCodeDataUrl.mockReset();
});

// ─── GET (status) ────────────────────────────────────────────────
describe("GET — auth gate", () => {
  it("no user → 401 Unauthorized", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("getUserById null → 404 'User not found'", async () => {
    getUserById.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("User not found");
  });
});

describe("GET — status response", () => {
  it("returns { totpEnabled } only (no other user fields leak)", async () => {
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      totpEnabled: true,
      // sensitive fields that must NOT leak
      totpSecret: "JBSWY3DPEHPK3PXP",
      totpSecretPending: "PENDING_SECRET_LEAK_ME",
      password: "hashed-pw",
    });
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ totpEnabled: true });
    const json = JSON.stringify(body);
    expect(json).not.toContain("JBSWY3DPEHPK3PXP");
    expect(json).not.toContain("PENDING_SECRET_LEAK_ME");
    expect(json).not.toContain("hashed-pw");
  });

  it("totpEnabled:false also returned cleanly", async () => {
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      totpEnabled: false,
    });
    const body = await (await GET(makeReq("GET"))).json();
    expect(body).toEqual({ totpEnabled: false });
  });
});

// ─── POST (enrollment) ──────────────────────────────────────────
describe("POST — auth gate", () => {
  it("no user → 401; NO secret generated", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq("POST"));
    expect(res.status).toBe(401);
    expect(generateTotpSecret).not.toHaveBeenCalled();
    expect(setPendingTOTPSecret).not.toHaveBeenCalled();
  });

  it("getUserById null → 404; NO secret generated", async () => {
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq("POST"));
    expect(res.status).toBe(404);
    expect(generateTotpSecret).not.toHaveBeenCalled();
  });
});

describe("POST — already-enabled guard (CRITICAL)", () => {
  it("dbUser.totpEnabled === true → 409 'already enabled. Disable it before re-enrolling.'; NO new secret stored", async () => {
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      totpEnabled: true,
    });
    const res = await POST(makeReq("POST"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already enabled");
    expect(body.error).toContain("Disable it before re-enrolling");
    expect(generateTotpSecret).not.toHaveBeenCalled();
    expect(setPendingTOTPSecret).not.toHaveBeenCalled();
  });
});

describe("POST — happy enrollment path", () => {
  it("calls generateTotpSecret → getTotpUri(secret, email) → generateQrCodeDataUrl(uri); stores pending secret", async () => {
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      totpEnabled: false,
    });
    generateTotpSecret.mockReturnValueOnce("SECRET_BASE32_FAKE");
    getTotpUri.mockReturnValueOnce(
      "otpauth://totp/Anutech:alice@example.com?secret=SECRET_BASE32_FAKE&issuer=Anutech"
    );
    generateQrCodeDataUrl.mockResolvedValueOnce(
      "data:image/png;base64,QR_FAKE_BYTES"
    );

    const res = await POST(makeReq("POST"));
    expect(res.status).toBe(200);

    // Pipeline call shape pinned
    expect(generateTotpSecret).toHaveBeenCalledTimes(1);
    expect(getTotpUri).toHaveBeenCalledWith(
      "SECRET_BASE32_FAKE",
      "alice@example.com"
    );
    expect(generateQrCodeDataUrl).toHaveBeenCalledWith(
      "otpauth://totp/Anutech:alice@example.com?secret=SECRET_BASE32_FAKE&issuer=Anutech"
    );

    // setPendingTOTPSecret called with (String(_id), secret)
    expect(setPendingTOTPSecret).toHaveBeenCalledWith(
      "U1",
      "SECRET_BASE32_FAKE"
    );

    const body = await res.json();
    expect(body).toEqual({
      qrCodeDataUrl: "data:image/png;base64,QR_FAKE_BYTES",
      manualKey: "SECRET_BASE32_FAKE",
    });
  });

  it("manualKey === the same secret (for users without a camera)", async () => {
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      totpEnabled: false,
    });
    generateTotpSecret.mockReturnValueOnce("EXACT_SAME_BASE32");
    getTotpUri.mockReturnValueOnce("otpauth://x");
    generateQrCodeDataUrl.mockResolvedValueOnce("data:image/png;base64,X");

    const body = await (await POST(makeReq("POST"))).json();
    expect(body.manualKey).toBe("EXACT_SAME_BASE32");
  });
});
