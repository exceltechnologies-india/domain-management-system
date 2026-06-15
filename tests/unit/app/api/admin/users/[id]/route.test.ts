/**
 * Tests for `app/api/admin/users/[id]/route.ts` (slice 7i3, part 2).
 *
 * Admin user CRUD: GET (single user), PUT (update), DELETE (soft).
 *
 * Threat model:
 *  - **Admin self-lockout**: an admin accidentally deactivating
 *    themselves would lock themselves out. Pinned: PUT self-target
 *    with isActive:false → 400.
 *  - **Last-admin lockout**: deleting the last admin makes the
 *    system unreachable for ops. Pinned: countAdmins ≤ 1 + target
 *    role='admin' → 400.
 *  - **Stolen-cookie destructive action**: a stolen admin session
 *    cookie alone must NOT be enough to soft-delete users. Pinned:
 *    DELETE requires step-up password re-auth → 403 REAUTH_REQUIRED.
 *
 * Other pins:
 *  - GET / PUT / DELETE all gate via verifyAdminAuth → 401
 *  - GET: getUserById null → 404
 *  - PUT zod: all fields optional; role enum 'user'|'admin'; email
 *    via Schemas.email
 *  - PUT self-deactivate: id === auth.user.id && isActive===false → 400
 *  - applyUserPatch null → 404
 *  - PUT response: curated 6-field shape (id, email, firstName,
 *    lastName, role, isActive)
 *  - DELETE step-up: requireReAuth.passed=false → 403
 *  - DELETE getUserById null → 404
 *  - DELETE self-target → 400 "Cannot delete your own account"
 *  - DELETE last-admin guard: target.role='admin' + countAdmins ≤ 1 → 400
 *  - DELETE happy: softDeleteUser called; 200 "deactivated"
 *  - Per-method outer catch → 500
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyAdminAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAuth }));

const requireReAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-security", () => ({ requireReAuth }));

const getUserById = vi.hoisted(() => vi.fn());
const countAdmins = vi.hoisted(() => vi.fn());
const applyUserPatch = vi.hoisted(() => vi.fn());
const softDeleteUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  getUserById,
  countAdmins,
  applyUserPatch,
  softDeleteUser,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, PUT, DELETE } from "@/app/api/admin/users/[id]/route";

const ADMIN_ID = "507f1f77bcf86cd799439001";
const TARGET_ID = "507f1f77bcf86cd799439002";

function makeReq(method: "GET" | "PUT" | "DELETE", body?: unknown) {
  return new NextRequest(`https://example.com/api/admin/users/${TARGET_ID}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeParams(id = TARGET_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  verifyAdminAuth.mockReset().mockResolvedValue({
    valid: true,
    user: { id: ADMIN_ID, email: "admin@example.com" },
  });
  requireReAuth.mockReset().mockResolvedValue({ passed: true });
  getUserById.mockReset();
  countAdmins.mockReset();
  applyUserPatch.mockReset();
  softDeleteUser.mockReset().mockResolvedValue(undefined);
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET — admin gate", () => {
  it("non-admin → 401; no DB read", async () => {
    verifyAdminAuth.mockResolvedValueOnce({ valid: false, error: "no auth" });
    const res = await GET(makeReq("GET"), makeParams());
    expect(res.status).toBe(401);
    expect(getUserById).not.toHaveBeenCalled();
  });
});

describe("GET — happy + 404", () => {
  it("user found → 200 with full user object", async () => {
    const target = {
      _id: TARGET_ID,
      email: "bob@example.com",
      firstName: "Bob",
      lastName: "Smith",
      role: "user",
    };
    getUserById.mockResolvedValueOnce(target);
    const res = await GET(makeReq("GET"), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user).toEqual(target);
  });

  it("getUserById null → 404", async () => {
    getUserById.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"), makeParams());
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────── PUT ─────────────────────────────

describe("PUT — admin gate", () => {
  it("non-admin → 401; no patch", async () => {
    verifyAdminAuth.mockResolvedValueOnce({ valid: false, error: "no auth" });
    const res = await PUT(
      makeReq("PUT", { firstName: "X" }),
      makeParams()
    );
    expect(res.status).toBe(401);
    expect(applyUserPatch).not.toHaveBeenCalled();
  });
});

describe("PUT — zod schema", () => {
  it("invalid role → 400", async () => {
    const res = await PUT(
      makeReq("PUT", { role: "superadmin" }),
      makeParams()
    );
    expect(res.status).toBe(400);
    expect(applyUserPatch).not.toHaveBeenCalled();
  });

  it("invalid email format → 400", async () => {
    const res = await PUT(
      makeReq("PUT", { email: "not-an-email" }),
      makeParams()
    );
    expect(res.status).toBe(400);
  });

  it("empty body → 200 (all fields optional)", async () => {
    applyUserPatch.mockResolvedValueOnce({
      _id: TARGET_ID,
      email: "x@y.com",
      firstName: "X",
      lastName: "Y",
      role: "user",
      isActive: true,
    });
    const res = await PUT(makeReq("PUT", {}), makeParams());
    expect(res.status).toBe(200);
  });
});

describe("PUT — self-deactivate block", () => {
  it("**id === admin's own _id + isActive=false → 400 'Cannot deactivate your own account'**", async () => {
    const res = await PUT(
      makeReq("PUT", { isActive: false }),
      makeParams(ADMIN_ID)
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain("deactivate");
    expect(applyUserPatch).not.toHaveBeenCalled();
  });

  it("id === admin's own _id + isActive=true (or undefined) → ALLOWED", async () => {
    applyUserPatch.mockResolvedValueOnce({
      _id: ADMIN_ID,
      email: "admin@example.com",
      firstName: "Admin",
      lastName: "Self",
      role: "admin",
      isActive: true,
    });
    const res = await PUT(
      makeReq("PUT", { firstName: "Renamed" }),
      makeParams(ADMIN_ID)
    );
    expect(res.status).toBe(200);
    expect(applyUserPatch).toHaveBeenCalledTimes(1);
  });

  it("different user + isActive=false → ALLOWED (admin can deactivate OTHERS)", async () => {
    applyUserPatch.mockResolvedValueOnce({
      _id: TARGET_ID,
      email: "bob@example.com",
      firstName: "Bob",
      lastName: "Smith",
      role: "user",
      isActive: false,
    });
    const res = await PUT(
      makeReq("PUT", { isActive: false }),
      makeParams()
    );
    expect(res.status).toBe(200);
  });
});

describe("PUT — 404 + response shape", () => {
  it("applyUserPatch returns null → 404", async () => {
    applyUserPatch.mockResolvedValueOnce(null);
    const res = await PUT(makeReq("PUT", { firstName: "X" }), makeParams());
    expect(res.status).toBe(404);
  });

  it("response is the curated 6-field shape (id, email, firstName, lastName, role, isActive)", async () => {
    applyUserPatch.mockResolvedValueOnce({
      _id: TARGET_ID,
      email: "bob@example.com",
      firstName: "Bob",
      lastName: "Smith",
      role: "user",
      isActive: true,
      // Sentinel fields that must NOT leak
      password: "$2a$12$BCRYPT_LEAK_ME",
      totpSecret: "JBSWY3DPEHPK3PXP",
    });
    const res = await PUT(makeReq("PUT", {}), makeParams());
    const body = await res.json();
    expect(Object.keys(body.user).sort()).toEqual([
      "email",
      "firstName",
      "id",
      "isActive",
      "lastName",
      "role",
    ]);
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_LEAK_ME");
    expect(JSON.stringify(body)).not.toContain("JBSWY3DPEHPK3PXP");
  });
});

// ─────────────────────────── DELETE ─────────────────────────────

describe("DELETE — admin gate + step-up", () => {
  it("non-admin → 401; no reauth, no delete", async () => {
    verifyAdminAuth.mockResolvedValueOnce({ valid: false, error: "no auth" });
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(401);
    expect(requireReAuth).not.toHaveBeenCalled();
    expect(softDeleteUser).not.toHaveBeenCalled();
  });

  it("**reauth.passed=false → 403 REAUTH_REQUIRED; NO user lookup, NO delete**", async () => {
    requireReAuth.mockResolvedValueOnce({ passed: false });
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("REAUTH_REQUIRED");
    expect(getUserById).not.toHaveBeenCalled();
    expect(softDeleteUser).not.toHaveBeenCalled();
  });

  it("reauth called with admin's own _id (anti-impersonation)", async () => {
    getUserById.mockResolvedValueOnce(null);
    await DELETE(makeReq("DELETE"), makeParams());
    expect(requireReAuth).toHaveBeenCalledWith(expect.anything(), ADMIN_ID);
  });
});

describe("DELETE — guards", () => {
  it("getUserById null → 404", async () => {
    getUserById.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(404);
    expect(softDeleteUser).not.toHaveBeenCalled();
  });

  it("**self-delete block: target._id === admin._id → 400**", async () => {
    getUserById.mockResolvedValueOnce({
      _id: ADMIN_ID,
      role: "admin",
      toString: () => ADMIN_ID,
    });
    const res = await DELETE(makeReq("DELETE"), makeParams(ADMIN_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain("delete your own");
    expect(softDeleteUser).not.toHaveBeenCalled();
  });

  it("**last-admin guard: target.role='admin' + countAdmins ≤ 1 → 400**", async () => {
    getUserById.mockResolvedValueOnce({
      _id: TARGET_ID,
      role: "admin",
    });
    countAdmins.mockResolvedValueOnce(1);
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain("last admin");
    expect(softDeleteUser).not.toHaveBeenCalled();
  });

  it("last-admin guard does NOT fire when countAdmins ≥ 2", async () => {
    getUserById.mockResolvedValueOnce({
      _id: TARGET_ID,
      role: "admin",
    });
    countAdmins.mockResolvedValueOnce(2);
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(200);
    expect(softDeleteUser).toHaveBeenCalledTimes(1);
  });

  it("last-admin guard does NOT fire for non-admin targets", async () => {
    getUserById.mockResolvedValueOnce({
      _id: TARGET_ID,
      role: "user",
    });
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(200);
    expect(countAdmins).not.toHaveBeenCalled();
    expect(softDeleteUser).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE — happy path", () => {
  it("regular user → softDeleteUser called; 200 with deactivated message", async () => {
    getUserById.mockResolvedValueOnce({ _id: TARGET_ID, role: "user" });
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(200);
    expect(softDeleteUser).toHaveBeenCalledWith(TARGET_ID);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message.toLowerCase()).toContain("deactivated");
  });
});

describe("Outer catches", () => {
  it("GET getUserById throw → 500", async () => {
    getUserById.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await GET(makeReq("GET"), makeParams());
    expect(res.status).toBe(500);
  });

  it("PUT applyUserPatch throw → 500", async () => {
    applyUserPatch.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await PUT(makeReq("PUT", { firstName: "X" }), makeParams());
    expect(res.status).toBe(500);
  });

  it("DELETE softDeleteUser throw → 500", async () => {
    getUserById.mockResolvedValueOnce({ _id: TARGET_ID, role: "user" });
    softDeleteUser.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(500);
  });
});
