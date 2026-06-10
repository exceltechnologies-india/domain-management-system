/**
 * Tests for `app/api/admin/support-tickets/route.ts` (slice 7go,
 * part 2). Admin list of all customer support tickets.
 *
 * Pins:
 *  - Admin gate via AuthService.isAdmin → 403 FORBIDDEN on non-
 *    admin (uses 403, not 401 — pinned alongside the deactivated-
 *    users 401 for the harmony audit)
 *  - Query params: status (optional, passed through), page
 *    (default 1, **clamped to min 1** via Math.max(1, ...) — anti-
 *    negative-offset)
 *  - listTicketsForAdmin called with `{ status, page, perPage: 25 }`
 *    — perPage is HARD-CODED at 25 (no per_page query param —
 *    pinned so a future "expose perPage" change goes through a
 *    review for DoS impact)
 *  - Response: `{ tickets, total, page, pages }`
 *  - Outer catch → 500 SERVER_ERROR (generic)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const listTicketsForAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/support-tickets", () => ({ listTicketsForAdmin }));

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
  listTicketsForAdmin.mockReset();
});

describe("Admin gate (returns 403)", () => {
  it("non-admin → 403 FORBIDDEN; NO list call", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(listTicketsForAdmin).not.toHaveBeenCalled();
  });
});

describe("Query parsing", () => {
  beforeEach(() => {
    isAdmin.mockResolvedValue(true);
    listTicketsForAdmin.mockResolvedValue({
      tickets: [],
      total: 0,
      page: 1,
      pages: 0,
    });
  });

  it("defaults: status=undefined, page=1, perPage:25 (HARD-CODED)", async () => {
    await GET(makeReq());
    expect(listTicketsForAdmin).toHaveBeenCalledWith({
      status: undefined,
      page: 1,
      perPage: 25,
    });
  });

  it("?status=open passes through", async () => {
    await GET(makeReq("status=open"));
    expect(listTicketsForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ status: "open" })
    );
  });

  it("?page=3 parsed as integer", async () => {
    await GET(makeReq("page=3"));
    expect(listTicketsForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ page: 3 })
    );
  });

  it("?page=-5 clamped to min 1 (anti-negative-offset)", async () => {
    await GET(makeReq("page=-5"));
    expect(listTicketsForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1 })
    );
  });

  it("?page=0 clamped to 1", async () => {
    await GET(makeReq("page=0"));
    expect(listTicketsForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1 })
    );
  });

  it("?page=garbage (NaN) — current behaviour leaks NaN through (Math.max(1, NaN)=NaN). Pinned for review.", async () => {
    await GET(makeReq("page=abc"));
    // ACTUAL current behaviour: parseInt('abc') → NaN, then
    // Math.max(1, NaN) === NaN (any compare with NaN is false). So
    // NaN reaches listTicketsForAdmin. This is a known quirk worth
    // pinning explicitly — a fix that adds Number.isFinite() guard
    // would change page to 1 here.
    expect(listTicketsForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ page: NaN })
    );
  });
});

describe("Response shape", () => {
  it("returns { tickets, total, page, pages }", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listTicketsForAdmin.mockResolvedValueOnce({
      tickets: [{ ticketNumber: "T-1" }],
      total: 42,
      page: 2,
      pages: 5,
    });
    const res = await GET(makeReq("page=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      tickets: [{ ticketNumber: "T-1" }],
      total: 42,
      page: 2,
      pages: 5,
    });
  });
});

describe("Error handling", () => {
  it("service throw → 500 SERVER_ERROR (generic, no leak)", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listTicketsForAdmin.mockRejectedValueOnce(new Error("DB blew up"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
  });
});
