/**
 * Tests for `app/api/admin/users/reactivate/route.ts` (slice 7gv,
 * part 2). Admin reactivates a deactivated user account.
 *
 * Pins:
 *  - Admin gate via getAdminFromRequest → 401 'Unauthorized'
 *  - zod schema: userId via Schemas.id (ObjectId-shaped)
 *  - User not found → 404 'User not found'
 *  - **isDeleted precondition**: target.isDeleted must be truthy.
 *    Calling reactivate on an already-active user → 400 'User is
 *    not deactivated'; reactivateUser NOT called. Pinned because
 *    this guard prevents an audit-log entry that says "admin
 *    reactivated user X" when nothing actually changed.
 *  - reactivateUser returning null → 404 (race window where the
 *    user was deleted between findById and reactivate)
 *  - **Response curates fields**: returns id / email / firstName
 *    / lastName / isActive ONLY. Tested against a source user
 *    record with internal fields (password, hostingExpiresAt,
 *    sessionInvalidatedAt, totpSecret, etc.) — none should leak.
 *  - Outer catch → 500 'Failed to reactivate user'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getUserById = vi.hoisted(() => vi.fn());
const reactivateUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  getUserById,
  reactivateUser,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/users/reactivate/route";

const VALID_ID = "507f1f77bcf86cd799439011";

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/admin/users/reactivate",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

const admin = { _id: "ADMIN_1", email: "admin@example.com" };

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  getUserById.mockReset();
  reactivateUser.mockReset();
});

describe("Admin gate", () => {
  it("non-admin → 401 'Unauthorized'; NO lookups", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ userId: VALID_ID }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(getUserById).not.toHaveBeenCalled();
    expect(reactivateUser).not.toHaveBeenCalled();
  });
});

describe("Body validation", () => {
  it("missing userId → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("malformed userId (not ObjectId-shaped per Schemas.id) → 400", async () => {
    const res = await POST(makeReq({ userId: "not-an-id" }));
    expect(res.status).toBe(400);
    expect(getUserById).not.toHaveBeenCalled();
  });
});

describe("User not found", () => {
  it("getUserById null → 404 'User not found'", async () => {
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ userId: VALID_ID }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("User not found");
    expect(reactivateUser).not.toHaveBeenCalled();
  });
});

describe("isDeleted precondition", () => {
  it("target.isDeleted FALSY → 400 'User is not deactivated'; reactivateUser NOT called", async () => {
    getUserById.mockResolvedValueOnce({
      _id: VALID_ID,
      email: "alice@example.com",
      isDeleted: false,
    });
    const res = await POST(makeReq({ userId: VALID_ID }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("User is not deactivated");
    expect(reactivateUser).not.toHaveBeenCalled();
  });

  it("target.isDeleted UNDEFINED treated as not-deactivated → 400", async () => {
    getUserById.mockResolvedValueOnce({
      _id: VALID_ID,
      email: "alice@example.com",
      // isDeleted not set
    });
    const res = await POST(makeReq({ userId: VALID_ID }));
    expect(res.status).toBe(400);
  });
});

describe("Race window: reactivateUser returns null after the precheck passes", () => {
  it("→ 404 'User not found' (the user was deleted between findById and reactivate)", async () => {
    getUserById.mockResolvedValueOnce({
      _id: VALID_ID,
      email: "alice@example.com",
      isDeleted: true,
    });
    reactivateUser.mockResolvedValueOnce(null);

    const res = await POST(makeReq({ userId: VALID_ID }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("User not found");
  });
});

describe("Happy path + response curation", () => {
  it("returns curated user object — internal fields NEVER leak", async () => {
    getUserById.mockResolvedValueOnce({
      _id: VALID_ID,
      email: "alice@example.com",
      isDeleted: true,
    });
    reactivateUser.mockResolvedValueOnce({
      _id: VALID_ID,
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      isActive: true,
      // Internal fields that must NOT bleed through:
      password: "secret-hash-leak-me-please",
      hostingExpiresAt: new Date("2027-01-01"),
      sessionInvalidatedAt: new Date("2026-06-10"),
      totpSecret: "JBSWY3DPEHPK3PXP_TOTP_LEAK",
      role: "user",
      directAdminUsername: "alice_da",
    });

    const res = await POST(makeReq({ userId: VALID_ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("User reactivated successfully");
    expect(body.user).toEqual({
      id: VALID_ID,
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      isActive: true,
    });

    const userJson = JSON.stringify(body.user);
    expect(userJson).not.toContain("secret-hash-leak");
    expect(userJson).not.toContain("JBSWY3DPEHPK3PXP_TOTP_LEAK");
    expect(userJson).not.toContain("totpSecret");
    expect(userJson).not.toContain("sessionInvalidatedAt");
    expect(userJson).not.toContain("hostingExpiresAt");
    expect(userJson).not.toContain("directAdminUsername");
    expect(userJson).not.toContain("role");
  });
});

describe("Outer catch", () => {
  it("reactivateUser throw → 500 'Failed to reactivate user' (no leak)", async () => {
    getUserById.mockResolvedValueOnce({
      _id: VALID_ID,
      email: "alice@example.com",
      isDeleted: true,
    });
    reactivateUser.mockRejectedValueOnce(new Error("Mongo timeout"));

    const res = await POST(makeReq({ userId: VALID_ID }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to reactivate user");
    expect(body.error).not.toContain("Mongo");
  });
});
