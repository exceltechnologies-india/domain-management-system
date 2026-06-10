/**
 * Tests for `app/api/admin/users/deactivated/route.ts` (slice 7go,
 * part 1). Admin list of deactivated user accounts. Used by the
 * admin reactivation tool.
 *
 * Pins:
 *  - Admin gate via getAdminFromRequest → 401 'Unauthorized' on
 *    null. **Note**: this endpoint returns 401 (not 403) on no-
 *    admin, unlike the other two endpoints in this slice which
 *    return 403. Pinned to highlight the inconsistency — both are
 *    valid status codes but a future audit may want to harmonise.
 *  - listDeactivatedUsers called with NO arguments (no filtering
 *    knobs exposed via this route; admin reactivation tool reads
 *    the full list)
 *  - Response shape: { success:true, users }
 *  - Service throw → 500 'Failed to fetch deactivated users' (no
 *    leak — generic message)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const listDeactivatedUsers = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ listDeactivatedUsers }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/users/deactivated/route";

function makeReq() {
  return new NextRequest("https://example.com/api/admin/users/deactivated", {
    method: "GET",
  });
}

beforeEach(() => {
  getAdminFromRequest.mockReset();
  listDeactivatedUsers.mockReset();
});

describe("Admin gate (returns 401, not 403 — pinned)", () => {
  it("non-admin → 401 'Unauthorized'; NO list call", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(listDeactivatedUsers).not.toHaveBeenCalled();
  });
});

describe("Admin path", () => {
  it("listDeactivatedUsers called with NO args (no per-route filtering)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1", role: "admin" });
    listDeactivatedUsers.mockResolvedValueOnce([
      { _id: "U1", isActive: false },
      { _id: "U2", isActive: false },
    ]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(listDeactivatedUsers).toHaveBeenCalledWith();
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      users: [
        { _id: "U1", isActive: false },
        { _id: "U2", isActive: false },
      ],
    });
  });
});

describe("Error handling", () => {
  it("service throw → 500 'Failed to fetch deactivated users' (no internals leaked)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1", role: "admin" });
    listDeactivatedUsers.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch deactivated users");
    expect(body.error).not.toContain("Mongo timeout");
  });
});
