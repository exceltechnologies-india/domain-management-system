/**
 * Tests for `app/api/admin/support-tickets/route.ts` (slice 7go,
 * part 2). Admin list of all customer support tickets.
 *
 * Rewritten for the Phase 2 DSP hand-off: legacy Mongo-backed pagination
 * (listTicketsForAdmin / page / perPage) was intentionally dropped from this
 * route — tickets now come from getDspTicketsForAdmin(status), which is a
 * best-effort call that never throws (DSP-unreachable resolves to []
 * internally, not an exception). Response shape is always
 * { tickets, total: tickets.length, page: 1, pages: 1 }.
 *
 * Pins:
 *  - Admin gate via AuthService.isAdmin → 403 FORBIDDEN on non-
 *    admin (uses 403, not 401 — pinned alongside the deactivated-
 *    users 401 for the harmony audit)
 *  - Query param: status, defaults to "all" (not undefined) when absent
 *  - getDspTicketsForAdmin called with just the status string — no
 *    page/perPage (pagination removed, DSP fetches a flat capped list)
 *  - Response: `{ tickets, total, page: 1, pages: 1 }` — total derives
 *    from tickets.length, page/pages are always 1 (no pagination anymore)
 *  - Outer catch → 500 SERVER_ERROR (generic) — still real protective
 *    code even though the current getDspTicketsForAdmin never throws
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const getDspTicketsForAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/support-tickets-admin", () => ({ getDspTicketsForAdmin }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/support-tickets/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/admin/support-tickets?${qs}`
    : "https://example.com/api/admin/support-tickets";
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  isAdmin.mockReset();
  getDspTicketsForAdmin.mockReset();
});

describe("Admin gate (returns 403)", () => {
  it("non-admin → 403 FORBIDDEN; NO list call", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(getDspTicketsForAdmin).not.toHaveBeenCalled();
  });
});

describe("Query parsing", () => {
  beforeEach(() => {
    isAdmin.mockResolvedValue(true);
    getDspTicketsForAdmin.mockResolvedValue([]);
  });

  it("no status param → defaults to 'all'", async () => {
    await GET(makeReq());
    expect(getDspTicketsForAdmin).toHaveBeenCalledWith("all");
  });

  it("?status=open passes through", async () => {
    await GET(makeReq("status=open"));
    expect(getDspTicketsForAdmin).toHaveBeenCalledWith("open");
  });
});

describe("Response shape", () => {
  it("returns { tickets, total, page: 1, pages: 1 } — total from tickets.length", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getDspTicketsForAdmin.mockResolvedValueOnce([
      { ticketNumber: "DSP-1" },
      { ticketNumber: "DSP-2" },
    ]);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      tickets: [{ ticketNumber: "DSP-1" }, { ticketNumber: "DSP-2" }],
      total: 2,
      page: 1,
      pages: 1,
    });
  });

  it("no tickets → total: 0, still page 1 / pages 1", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getDspTicketsForAdmin.mockResolvedValueOnce([]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body).toEqual({ tickets: [], total: 0, page: 1, pages: 1 });
  });
});

describe("Error handling", () => {
  it("service throw → 500 SERVER_ERROR (generic, no leak)", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getDspTicketsForAdmin.mockRejectedValueOnce(new Error("DB blew up"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
  });
});
