/**
 * Tests for `app/api/admin/users/reset-2fa/route.ts` (slice 7gv,
 * part 1). Admin disables 2FA for a non-admin user (recovery flow
 * when a customer loses their TOTP device).
 *
 * Security-critical pins:
 *  - **Admin-protection guard**: this endpoint REFUSES to reset
 *    2FA on accounts where `role === 'admin'`. Without this, any
 *    admin could downgrade another admin's 2FA protection through
 *    a normal-looking customer-service flow.
 *  - **Two-step lookup**: findUserRoleById first (cheap, role-only
 *    projection — runs before the full user fetch) → THEN
 *    getUserById to read totpEnabled. Pinned so a refactor that
 *    collapses into one full-doc query doesn't accidentally widen
 *    what reaches the handler scope.
 *  - **Pre-condition**: target.totpEnabled must be truthy.
 *    Resetting 2FA on a user who never had it enabled would be a
 *    no-op + confusing audit log; route returns 400 instead.
 *
 * Other pins:
 *  - Admin gate via getAdminFromRequest → 401 UNAUTHORIZED
 *  - zod schema: userId required, min 1 char
 *  - User not found → 404 NOT_FOUND
 *  - Happy path → 200 with first+last name in message;
 *    resetUser2FA invoked
 *  - Outer catch → 500 SERVER_ERROR generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const findUserRoleById = vi.hoisted(() => vi.fn());
const getUserById = vi.hoisted(() => vi.fn());
const resetUser2FA = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  findUserRoleById,
  getUserById,
  resetUser2FA,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/users/reset-2fa/route";

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/admin/users/reset-2fa",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

const admin = { _id: "ADMIN_1", email: "admin@example.com", role: "admin" };

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  findUserRoleById.mockReset();
  getUserById.mockReset();
  resetUser2FA.mockReset();
});

describe("Admin gate", () => {
  it("non-admin → 401 UNAUTHORIZED; NO downstream calls", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ userId: "U1" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(findUserRoleById).not.toHaveBeenCalled();
    expect(resetUser2FA).not.toHaveBeenCalled();
  });
});

describe("Body validation", () => {
  it("missing userId → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(findUserRoleById).not.toHaveBeenCalled();
  });

  it("empty userId → 400 (min:1 on the schema)", async () => {
    const res = await POST(makeReq({ userId: "" }));
    expect(res.status).toBe(400);
  });
});

describe("Two-step lookup ordering", () => {
  it("findUserRoleById runs BEFORE getUserById (cheap role projection first)", async () => {
    const callOrder: string[] = [];
    findUserRoleById.mockImplementationOnce(() => {
      callOrder.push("findUserRoleById");
      return Promise.resolve(null);
    });

    await POST(makeReq({ userId: "U1" }));
    expect(callOrder).toEqual(["findUserRoleById"]);
    expect(getUserById).not.toHaveBeenCalled();
  });
});

describe("User not found", () => {
  it("findUserRoleById null → 404 NOT_FOUND; no further calls", async () => {
    findUserRoleById.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ userId: "U_GHOST" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(getUserById).not.toHaveBeenCalled();
    expect(resetUser2FA).not.toHaveBeenCalled();
  });
});

describe("Admin-protection guard (CRITICAL)", () => {
  it("target role === 'admin' → 403 FORBIDDEN 'Cannot modify admin accounts via this endpoint'; NO 2FA reset", async () => {
    findUserRoleById.mockResolvedValueOnce({ role: "admin" });
    const res = await POST(makeReq({ userId: "OTHER_ADMIN_2" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(body.error).toContain("admin accounts");
    expect(getUserById).not.toHaveBeenCalled();
    expect(resetUser2FA).not.toHaveBeenCalled();
  });

  it("target role 'user' → proceeds past the guard", async () => {
    findUserRoleById.mockResolvedValueOnce({ role: "user" });
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      totpEnabled: true,
    });
    resetUser2FA.mockResolvedValueOnce(undefined);

    const res = await POST(makeReq({ userId: "U1" }));
    expect(res.status).toBe(200);
    expect(resetUser2FA).toHaveBeenCalled();
  });
});

describe("totpEnabled precondition", () => {
  it("target.totpEnabled falsy → 400 BAD_REQUEST 'does not have 2FA enabled'; resetUser2FA NOT called", async () => {
    findUserRoleById.mockResolvedValueOnce({ role: "user" });
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "A",
      totpEnabled: false,
    });

    const res = await POST(makeReq({ userId: "U1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.error).toContain("2FA enabled");
    expect(resetUser2FA).not.toHaveBeenCalled();
  });

  it("getUserById null → 400 (same path; the route uses optional-chain target?.totpEnabled)", async () => {
    findUserRoleById.mockResolvedValueOnce({ role: "user" });
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ userId: "U1" }));
    expect(res.status).toBe(400);
    expect(resetUser2FA).not.toHaveBeenCalled();
  });
});

describe("Happy path", () => {
  it("calls resetUser2FA with userId; 200 with first + last name in message", async () => {
    findUserRoleById.mockResolvedValueOnce({ role: "user" });
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      totpEnabled: true,
    });
    resetUser2FA.mockResolvedValueOnce(undefined);

    const res = await POST(makeReq({ userId: "U1" }));
    expect(res.status).toBe(200);
    expect(resetUser2FA).toHaveBeenCalledWith("U1");
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("Alice Anderson");
    expect(body.message).toContain("disabled");
  });
});

describe("Outer catch", () => {
  it("resetUser2FA throw → 500 SERVER_ERROR generic", async () => {
    findUserRoleById.mockResolvedValueOnce({ role: "user" });
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "A",
      totpEnabled: true,
    });
    resetUser2FA.mockRejectedValueOnce(new Error("Mongo timeout"));

    const res = await POST(makeReq({ userId: "U1" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
    expect(body.error).toBe("Failed to reset 2FA");
  });
});
