/**
 * Tests for `app/api/admin/users/no-hosting/route.ts` (slice 7gq,
 * part 1). Admin "eligible-user" picker — despite the legacy route
 * name "no-hosting", it now returns the full eligible-for-hosting
 * list (used by the admin manual-provision form to pick any user).
 *
 * Pins:
 *  - Admin gate via AuthService.isAdmin → 403 'Unauthorized. Admin
 *    access required.' + code FORBIDDEN (uses 403 not 401)
 *  - listEligibleUsersForAdminPicker called with NO args (returns
 *    the full eligible list)
 *  - **Response field mapping pinned**: each user shaped as
 *    `{ id: u._id, name: `${u.firstName} ${u.lastName}`, email }`
 *    — only id/name/email reach the client (no roles, no
 *    isActive, no internal flags)
 *  - **NEGATIVE leak guard**: response must NOT contain
 *    role / isActive / password / hostingExpiresAt / phone fields
 *  - Outer catch → 500 USERS_FETCH_FAILED with generic message
 *    'Failed to fetch users' (no error.message leak)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const listEligibleUsersForAdminPicker = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  listEligibleUsersForAdminPicker,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/users/no-hosting/route";

function makeReq() {
  return new NextRequest("https://example.com/api/admin/users/no-hosting", {
    method: "GET",
  });
}

beforeEach(() => {
  isAdmin.mockReset();
  listEligibleUsersForAdminPicker.mockReset();
});

describe("Admin gate", () => {
  it("non-admin → 403 FORBIDDEN with explicit 'Admin access required' message", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(body.error).toContain("Admin access required");
    expect(listEligibleUsersForAdminPicker).not.toHaveBeenCalled();
  });
});

describe("Happy path", () => {
  it("listEligibleUsersForAdminPicker called with NO args", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listEligibleUsersForAdminPicker.mockResolvedValueOnce([]);
    await GET(makeReq());
    expect(listEligibleUsersForAdminPicker).toHaveBeenCalledWith();
  });

  it("response: only id / name (firstName + lastName) / email reach the client", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listEligibleUsersForAdminPicker.mockResolvedValueOnce([
      {
        _id: "U1",
        firstName: "Alice",
        lastName: "Anderson",
        email: "alice@example.com",
        role: "user",
        isActive: true,
        password: "hashed-secret-should-never-leak",
        phone: "+91-1234567890",
        hostingExpiresAt: new Date("2027-01-01"),
      },
      {
        _id: "U2",
        firstName: "Bob",
        lastName: "Brown",
        email: "bob@example.com",
        role: "user",
        isActive: true,
        password: "another-hash",
      },
    ]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      id: "U1",
      name: "Alice Anderson",
      email: "alice@example.com",
    });
    expect(body.data[1]).toEqual({
      id: "U2",
      name: "Bob Brown",
      email: "bob@example.com",
    });
  });

  it("NEGATIVE leak guard: response body must NOT carry role / isActive / password / hostingExpiresAt / phone", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listEligibleUsersForAdminPicker.mockResolvedValueOnce([
      {
        _id: "U1",
        firstName: "Alice",
        lastName: "Anderson",
        email: "alice@example.com",
        role: "user",
        isActive: true,
        password: "hashed-secret-should-never-leak",
        phone: "+91-1234567890",
        hostingExpiresAt: new Date("2027-01-01"),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    const userJson = JSON.stringify(body.data[0]);

    expect(userJson).not.toContain("hashed-secret-should-never-leak");
    expect(userJson).not.toContain("+91-1234567890");
    expect(userJson).not.toContain("hostingExpiresAt");
    expect(userJson).not.toContain("role");
    expect(userJson).not.toContain("isActive");
  });
});

describe("Error handling", () => {
  it("service throw → 500 USERS_FETCH_FAILED with generic message", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listEligibleUsersForAdminPicker.mockRejectedValueOnce(
      new Error("Mongo connection: bson parse failed")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("USERS_FETCH_FAILED");
    expect(body.error).toBe("Failed to fetch users");
    expect(body.error).not.toContain("Mongo");
    expect(body.error).not.toContain("bson");
  });
});
