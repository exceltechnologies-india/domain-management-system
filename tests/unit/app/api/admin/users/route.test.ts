/**
 * Tests for `app/api/admin/users/route.ts` (slice 7i7, part 1).
 *
 * Admin user-management list (GET) + role-update (PUT) + delete (DELETE).
 *
 * Threat model:
 *  - **Sensitive-field leak in user list**: a refactor that returned
 *    the user object verbatim would surface password hashes, TOTP
 *    secrets, reset tokens in every admin list call. Pinned via
 *    explicit 9-field whitelist + sentinel-leak guard.
 *  - **Peer-admin escalation via role-update**: the PUT path must
 *    refuse to operate on admin targets — otherwise an admin could
 *    use the customer-service tooling to demote a peer admin to user
 *    (locking them out of the admin panel). Pinned 403.
 *  - **Self-lockout on delete**: admin deleting their own account
 *    locks them out. Pinned 400.
 *  - **Hard-vs-soft delete confusion**: a refactor coercing the
 *    `permanent` query string to boolean would loose-truthy-flip
 *    everything to permanent. Pinned: strict `=== 'true'`.
 *
 * Other pins:
 *  - GET admin gate → 401
 *  - GET pagination: page=Math.max(1,…); limit=Math.min(100,Math.max(1,…));
 *    default page=1 limit=50
 *  - listUsers filter pinned: { role: { $ne: 'admin' }, isDeleted: { $ne: true } }
 *  - PUT zod via Schemas.adminUserUpdate (.strict() rejects extras)
 *  - PUT findUserRoleById null → 404
 *  - PUT target.role='admin' → 403
 *  - PUT updateUserRole null (race) → 404
 *  - PUT response: curated 5-field shape
 *  - DELETE zod userId via Schemas.id
 *  - DELETE self → 400 'Cannot delete your own'
 *  - DELETE target null → 404
 *  - DELETE target.role='admin' → 403
 *  - DELETE strict-true 'permanent=true' → permanentDeleteUser
 *    with ordersSnapshotted log; anything else → softDeleteUser
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const listUsers = vi.hoisted(() => vi.fn());
const findUserRoleById = vi.hoisted(() => vi.fn());
const updateUserRole = vi.hoisted(() => vi.fn());
const softDeleteUser = vi.hoisted(() => vi.fn());
const permanentDeleteUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  listUsers,
  findUserRoleById,
  updateUserRole,
  softDeleteUser,
  permanentDeleteUser,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, PUT, DELETE } from "@/app/api/admin/users/route";

const ADMIN_ID = "507f1f77bcf86cd799439001";
const TARGET_ID = "507f1f77bcf86cd799439002";

function makeReq(
  method: "GET" | "PUT" | "DELETE",
  body?: unknown,
  qs = ""
) {
  const url = qs
    ? `https://example.com/api/admin/users?${qs}`
    : "https://example.com/api/admin/users";
  return new NextRequest(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({
    _id: { toString: () => ADMIN_ID },
    role: "admin",
  });
  listUsers.mockReset();
  findUserRoleById.mockReset();
  updateUserRole.mockReset();
  softDeleteUser.mockReset().mockResolvedValue({ _id: TARGET_ID });
  permanentDeleteUser.mockReset().mockResolvedValue({ ordersSnapshotted: 3 });
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET — admin gate", () => {
  it("non-admin → 401; no DB read", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
    expect(listUsers).not.toHaveBeenCalled();
  });
});

describe("GET — filter pinned (exclude peer admins + deleted)", () => {
  it("listUsers called with filter { role: { $ne: 'admin' }, isDeleted: { $ne: true } }", async () => {
    listUsers.mockResolvedValueOnce({
      users: [],
      total: 0,
      totalPages: 0,
      hasMore: false,
    });
    await GET(makeReq("GET"));
    expect(listUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          role: { $ne: "admin" },
          isDeleted: { $ne: true },
        },
      })
    );
  });
});

describe("GET — pagination clamps", () => {
  beforeEach(() => {
    listUsers.mockResolvedValue({
      users: [],
      total: 0,
      totalPages: 0,
      hasMore: false,
    });
  });

  it("page=0 → clamped to 1", async () => {
    await GET(makeReq("GET", undefined, "page=0"));
    expect(listUsers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1 })
    );
  });

  it("page=-5 → clamped to 1", async () => {
    await GET(makeReq("GET", undefined, "page=-5"));
    expect(listUsers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1 })
    );
  });

  it("limit=200 → clamped to 100 (MAX_PAGE_SIZE)", async () => {
    await GET(makeReq("GET", undefined, "limit=200"));
    expect(listUsers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 })
    );
  });

  it("limit=0 → clamped to 1", async () => {
    await GET(makeReq("GET", undefined, "limit=0"));
    expect(listUsers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 })
    );
  });

  it("defaults: page=1, limit=50", async () => {
    await GET(makeReq("GET"));
    expect(listUsers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 50 })
    );
  });
});

describe("GET — sensitive-field curation (anti-leak)", () => {
  it("returns 9-field curated shape; sentinels NOT in body", async () => {
    listUsers.mockResolvedValueOnce({
      users: [
        {
          _id: TARGET_ID,
          firstName: "Bob",
          lastName: "Smith",
          email: "bob@example.com",
          role: "user",
          createdAt: new Date("2026-01-01"),
          isActive: true,
          hostingCreatedAt: new Date("2026-02-01"),
          hostingExpiresAt: new Date("2027-02-01"),
          totpEnabled: true,
          // Sentinel fields that MUST be absent from response
          password: "$2a$12$BCRYPT_LEAK_ME",
          totpSecret: "JBSWY3DPEHPK3PXP",
          resetToken: "tok_LEAK_ME",
          pendingEmailToken: "email_LEAK",
        },
      ],
      total: 1,
      totalPages: 1,
      hasMore: false,
    });
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.users[0]).toEqual(
      expect.objectContaining({
        _id: TARGET_ID,
        firstName: "Bob",
        lastName: "Smith",
        email: "bob@example.com",
        role: "user",
        isActive: true,
        totpEnabled: true,
      })
    );
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("$2a$12$BCRYPT_LEAK_ME");
    expect(raw).not.toContain("JBSWY3DPEHPK3PXP");
    expect(raw).not.toContain("tok_LEAK_ME");
    expect(raw).not.toContain("email_LEAK");
  });

  it("isActive defaults to true when field is undefined (NOT false)", async () => {
    listUsers.mockResolvedValueOnce({
      users: [
        {
          _id: TARGET_ID,
          firstName: "X",
          lastName: "Y",
          email: "x@y.com",
          role: "user",
          // no isActive
        },
      ],
      total: 1,
      totalPages: 1,
      hasMore: false,
    });
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.users[0].isActive).toBe(true);
  });

  it("isActive=false flows through as false", async () => {
    listUsers.mockResolvedValueOnce({
      users: [
        {
          _id: TARGET_ID,
          firstName: "X",
          lastName: "Y",
          email: "x@y.com",
          role: "user",
          isActive: false,
        },
      ],
      total: 1,
      totalPages: 1,
      hasMore: false,
    });
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.users[0].isActive).toBe(false);
  });

  it("totpEnabled strict-true; undefined → false", async () => {
    listUsers.mockResolvedValueOnce({
      users: [
        {
          _id: TARGET_ID,
          firstName: "X",
          lastName: "Y",
          email: "x@y.com",
          role: "user",
          // no totpEnabled
        },
      ],
      total: 1,
      totalPages: 1,
      hasMore: false,
    });
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.users[0].totpEnabled).toBe(false);
  });
});

describe("GET — response pagination block", () => {
  it("carries page/limit/total/totalPages/hasMore", async () => {
    listUsers.mockResolvedValueOnce({
      users: [],
      total: 200,
      totalPages: 4,
      hasMore: true,
    });
    const res = await GET(makeReq("GET", undefined, "page=2&limit=50"));
    const body = await res.json();
    expect(body.pagination).toEqual({
      page: 2,
      limit: 50,
      total: 200,
      totalPages: 4,
      hasMore: true,
    });
  });
});

// ─────────────────────────── PUT ─────────────────────────────

describe("PUT — admin gate + schema", () => {
  it("non-admin → 401", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await PUT(makeReq("PUT", { userId: TARGET_ID, role: "user" }));
    expect(res.status).toBe(401);
    expect(findUserRoleById).not.toHaveBeenCalled();
  });

  it("invalid role → 400", async () => {
    const res = await PUT(
      makeReq("PUT", { userId: TARGET_ID, role: "superadmin" })
    );
    expect(res.status).toBe(400);
  });

  it("missing userId → 400", async () => {
    const res = await PUT(makeReq("PUT", { role: "user" }));
    expect(res.status).toBe(400);
  });

  it("**.strict() extra fields rejected → 400**", async () => {
    const res = await PUT(
      makeReq("PUT", {
        userId: TARGET_ID,
        role: "user",
        password: "hostile",
      })
    );
    expect(res.status).toBe(400);
  });

  it("invalid userId format (not ObjectId) → 400", async () => {
    const res = await PUT(
      makeReq("PUT", { userId: "not-an-objectid", role: "user" })
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT — privilege guard", () => {
  it("target user not found → 404", async () => {
    findUserRoleById.mockResolvedValueOnce(null);
    const res = await PUT(
      makeReq("PUT", { userId: TARGET_ID, role: "user" })
    );
    expect(res.status).toBe(404);
  });

  it("**target.role='admin' → 403 FORBIDDEN (peer-admin privilege guard)**", async () => {
    findUserRoleById.mockResolvedValueOnce({ role: "admin" });
    const res = await PUT(
      makeReq("PUT", { userId: TARGET_ID, role: "user" })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(updateUserRole).not.toHaveBeenCalled();
  });

  it("updateUserRole null (race) → 404", async () => {
    findUserRoleById.mockResolvedValueOnce({ role: "user" });
    updateUserRole.mockResolvedValueOnce(null);
    const res = await PUT(
      makeReq("PUT", { userId: TARGET_ID, role: "user" })
    );
    expect(res.status).toBe(404);
  });
});

describe("PUT — happy path response", () => {
  it("returns curated 5-field user shape", async () => {
    findUserRoleById.mockResolvedValueOnce({ role: "user" });
    updateUserRole.mockResolvedValueOnce({
      _id: TARGET_ID,
      firstName: "Bob",
      lastName: "Smith",
      email: "bob@example.com",
      role: "admin",
      // Sentinel must not leak
      password: "$2a$12$BCRYPT_LEAK",
    });
    const res = await PUT(
      makeReq("PUT", { userId: TARGET_ID, role: "admin" })
    );
    const body = await res.json();
    expect(body.user).toEqual({
      _id: TARGET_ID,
      firstName: "Bob",
      lastName: "Smith",
      email: "bob@example.com",
      role: "admin",
    });
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_LEAK");
  });
});

// ─────────────────────────── DELETE ─────────────────────────────

describe("DELETE — admin gate + schema", () => {
  it("non-admin → 401", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq("DELETE", { userId: TARGET_ID }));
    expect(res.status).toBe(401);
    expect(softDeleteUser).not.toHaveBeenCalled();
  });

  it("invalid userId → 400 VALIDATION_ERROR", async () => {
    const res = await DELETE(makeReq("DELETE", { userId: "not-an-objectid" }));
    expect(res.status).toBe(400);
  });
});

describe("DELETE — guards", () => {
  it("**self-delete → 400 'Cannot delete your own account'**", async () => {
    const res = await DELETE(makeReq("DELETE", { userId: ADMIN_ID }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain("own account");
    expect(findUserRoleById).not.toHaveBeenCalled();
  });

  it("target not found → 404", async () => {
    findUserRoleById.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq("DELETE", { userId: TARGET_ID }));
    expect(res.status).toBe(404);
  });

  it("**target.role='admin' → 403 FORBIDDEN**", async () => {
    findUserRoleById.mockResolvedValueOnce({ role: "admin" });
    const res = await DELETE(makeReq("DELETE", { userId: TARGET_ID }));
    expect(res.status).toBe(403);
    expect(softDeleteUser).not.toHaveBeenCalled();
    expect(permanentDeleteUser).not.toHaveBeenCalled();
  });
});

describe("DELETE — soft vs permanent dispatch", () => {
  beforeEach(() => {
    findUserRoleById.mockResolvedValue({ role: "user" });
  });

  it("no ?permanent → softDeleteUser called (default)", async () => {
    const res = await DELETE(makeReq("DELETE", { userId: TARGET_ID }));
    expect(res.status).toBe(200);
    expect(softDeleteUser).toHaveBeenCalledWith(TARGET_ID);
    expect(permanentDeleteUser).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.message.toLowerCase()).toContain("deactivated");
  });

  it("?permanent=true → permanentDeleteUser; soft NOT called", async () => {
    const req = new NextRequest(
      `https://example.com/api/admin/users?permanent=true`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: TARGET_ID }),
      }
    );
    const res = await DELETE(req);
    expect(res.status).toBe(200);
    expect(permanentDeleteUser).toHaveBeenCalledWith(TARGET_ID);
    expect(softDeleteUser).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.message.toLowerCase()).toContain("permanently");
  });

  it("**strict-true: ?permanent=TRUE → soft (case-sensitive)**", async () => {
    const req = new NextRequest(
      `https://example.com/api/admin/users?permanent=TRUE`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: TARGET_ID }),
      }
    );
    await DELETE(req);
    expect(softDeleteUser).toHaveBeenCalledTimes(1);
    expect(permanentDeleteUser).not.toHaveBeenCalled();
  });

  it("**strict-true: ?permanent=1 → soft**", async () => {
    const req = new NextRequest(
      `https://example.com/api/admin/users?permanent=1`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: TARGET_ID }),
      }
    );
    await DELETE(req);
    expect(softDeleteUser).toHaveBeenCalledTimes(1);
    expect(permanentDeleteUser).not.toHaveBeenCalled();
  });

  it("**strict-true: ?permanent=yes → soft**", async () => {
    const req = new NextRequest(
      `https://example.com/api/admin/users?permanent=yes`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: TARGET_ID }),
      }
    );
    await DELETE(req);
    expect(softDeleteUser).toHaveBeenCalledTimes(1);
  });

  it("softDeleteUser null → 404", async () => {
    softDeleteUser.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq("DELETE", { userId: TARGET_ID }));
    expect(res.status).toBe(404);
  });
});
