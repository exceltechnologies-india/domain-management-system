/**
 * Tests for `app/api/admin/hosting/pending/route.ts` (slice 7go,
 * part 3). Admin list of hosting accounts that failed to provision
 * on the first attempt and are queued for retry.
 *
 * Pins:
 *  - Admin gate via AuthService.isAdmin → 403 FORBIDDEN (matches
 *    support-tickets, NOT the 401 used by deactivated-users —
 *    pinned alongside both for the harmony audit)
 *  - listPendingHostingsForAdmin called with NO args
 *  - Response shape: { success:true, data }
 *  - **Error-handling quirk pinned**: on service throw, this route
 *    surfaces the raw `error.message` to the client (NOT a generic
 *    string like the other two routes in the slice). Test pins
 *    the current behaviour so a future hardening pass that masks
 *    the message has a known signal. (The error.message can leak
 *    Mongo error fragments — flag for review.)
 *  - Non-Error throw → 'Server error' fallback
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const listPendingHostingsForAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-hostings", () => ({
  listPendingHostingsForAdmin,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/hosting/pending/route";

function makeReq() {
  return new NextRequest("https://example.com/api/admin/hosting/pending", {
    method: "GET",
  });
}

beforeEach(() => {
  isAdmin.mockReset();
  listPendingHostingsForAdmin.mockReset();
});

describe("Admin gate", () => {
  it("non-admin → 403 FORBIDDEN; NO list call", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(listPendingHostingsForAdmin).not.toHaveBeenCalled();
  });
});

describe("Happy path", () => {
  it("calls listPendingHostingsForAdmin with NO args; returns { success, data }", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listPendingHostingsForAdmin.mockResolvedValueOnce([
      { _id: "P1", status: "failed" },
      { _id: "P2", status: "failed" },
    ]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(listPendingHostingsForAdmin).toHaveBeenCalledWith();
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: [
        { _id: "P1", status: "failed" },
        { _id: "P2", status: "failed" },
      ],
    });
  });
});

describe("Error handling — raw message leak (pinned for review)", () => {
  it("service throw with Error → 500 with **raw error.message** surfaced (inconsistent with sibling routes; pinned as the current behaviour)", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listPendingHostingsForAdmin.mockRejectedValueOnce(
      new Error("Mongo connection refused: bson parse failed")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    // Current behaviour: raw message reaches the client.
    // FUTURE: if this gets hardened to a generic 'Server error', this
    // test will fail and force a review/update.
    expect(body.error).toBe("Mongo connection refused: bson parse failed");
    expect(body.code).toBe("SERVER_ERROR");
  });

  it("non-Error throw (e.g. string) → 'Server error' fallback", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listPendingHostingsForAdmin.mockRejectedValueOnce("just a string");
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Server error");
  });
});
