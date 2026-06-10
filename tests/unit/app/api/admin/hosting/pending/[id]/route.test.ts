/**
 * Tests for `app/api/admin/hosting/pending/[id]/route.ts` (slice
 * 7gr, part 1). Admin deletes a stuck PendingHosting row (the row
 * holds the retry-able state for a failed manual-provision).
 *
 * Pins:
 *  - Admin gate via isAdmin → 403 FORBIDDEN (matches 7go pending
 *    LIST style + 7gp ip-status uses 401; the inconsistency
 *    remains documented across slices)
 *  - deletePendingHostingById(id) is the only side effect
 *  - Falsy return → 404 NOT_FOUND 'Entry not found'
 *  - Success → 200 with `{ success:true, message: 'Pending hosting
 *    entry deleted successfully' }`
 *  - **Error-leak pinned**: outer-catch with an Error instance
 *    surfaces `error.message` to the client (matches the 7go
 *    pending-LIST quirk — same file family). Pinned to signal a
 *    coordinated hardening pass.
 *  - Non-Error throw → 'Server error' fallback
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const deletePendingHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-hostings", () => ({
  deletePendingHostingById,
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { DELETE } from "@/app/api/admin/hosting/pending/[id]/route";

function makeReq() {
  return new NextRequest("https://example.com/api/admin/hosting/pending/P1", {
    method: "DELETE",
  });
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  isAdmin.mockReset();
  deletePendingHostingById.mockReset();
});

describe("Admin gate (403)", () => {
  it("non-admin → 403 FORBIDDEN; NO delete call", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await DELETE(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(deletePendingHostingById).not.toHaveBeenCalled();
  });
});

describe("Delete service call", () => {
  it("calls deletePendingHostingById with the route param id", async () => {
    isAdmin.mockResolvedValueOnce(true);
    deletePendingHostingById.mockResolvedValueOnce(true);
    await DELETE(makeReq(), paramsOf("P_TARGET_12345"));
    expect(deletePendingHostingById).toHaveBeenCalledWith("P_TARGET_12345");
  });
});

describe("Not found → 404", () => {
  it("falsy return → 404 NOT_FOUND 'Entry not found'", async () => {
    isAdmin.mockResolvedValueOnce(true);
    deletePendingHostingById.mockResolvedValueOnce(false);
    const res = await DELETE(makeReq(), paramsOf("P_MISSING"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.error).toBe("Entry not found");
  });
});

describe("Success", () => {
  it("truthy return → 200 with success + message", async () => {
    isAdmin.mockResolvedValueOnce(true);
    deletePendingHostingById.mockResolvedValueOnce(true);
    const res = await DELETE(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message: "Pending hosting entry deleted successfully",
    });
  });
});

describe("Outer catch — error-leak pinned (same as 7go pending-LIST)", () => {
  it("Error instance throw → 500 with **raw error.message** (matches sibling pending-LIST quirk; pinned for coordinated future hardening)", async () => {
    isAdmin.mockResolvedValueOnce(true);
    deletePendingHostingById.mockRejectedValueOnce(
      new Error("Mongo write concern timeout: bson failure")
    );
    const res = await DELETE(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
    expect(body.error).toBe("Mongo write concern timeout: bson failure");
  });

  it("non-Error throw → 'Server error' fallback", async () => {
    isAdmin.mockResolvedValueOnce(true);
    deletePendingHostingById.mockRejectedValueOnce("string-throw");
    const res = await DELETE(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Server error");
  });
});
