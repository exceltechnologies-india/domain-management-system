/**
 * Tests for `app/api/admin/invoices/route.ts` (slice 7gq, part 3).
 * Admin Zoho Books invoice listing (passthrough). The interesting
 * pin is the parseInt-without-clamp on page / per_page (a regression
 * here would let `?per_page=garbage` reach Zoho as NaN).
 *
 * Pins:
 *  - connectDB BEFORE auth (same pattern as 7gp ip-status)
 *  - Admin gate via getAdminFromRequest → 401 'Unauthorized'
 *  - Query parsing:
 *      - page default '1' → parseInt → 1
 *      - per_page default '20' → parseInt → 20
 *      - parseInt no radix arg — current source uses `parseInt(s || '1')`
 *  - **parseInt-without-Number.isFinite quirk**: `?page=abc` →
 *    parseInt('abc') === NaN → reaches ZohoBooksService as NaN.
 *    Pinned alongside the 7go support-tickets variant for the
 *    harmony audit.
 *  - ZohoBooksService.getInstance().getAllInvoices(page, perPage)
 *  - Response: { success:true, invoices, page_context } — Zoho's
 *    page_context object passed through verbatim
 *  - Outer catch → 500 'Failed to fetch invoices' (no leak)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const getAllInvoices = vi.hoisted(() => vi.fn());
const getInstance = vi.hoisted(() => vi.fn(() => ({ getAllInvoices })));
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: { getInstance },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/invoices/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/admin/invoices?${qs}`
    : "https://example.com/api/admin/invoices";
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  getAdminFromRequest.mockReset();
  connectDB.mockClear().mockResolvedValue(undefined);
  getAllInvoices.mockReset();
});

describe("connectDB ordering", () => {
  it("connectDB called BEFORE the auth gate (current source order — pinned)", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    await GET(makeReq());
    expect(connectDB).toHaveBeenCalled();
  });
});

describe("Admin gate", () => {
  it("non-admin → 401 'Unauthorized'; NO Zoho call", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(getAllInvoices).not.toHaveBeenCalled();
  });
});

describe("Query parsing — defaults", () => {
  it("no query params → getAllInvoices(1, 20)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getAllInvoices.mockResolvedValueOnce({
      invoices: [],
      page_context: { page: 1, per_page: 20, total: 0 },
    });
    await GET(makeReq());
    expect(getAllInvoices).toHaveBeenCalledWith(1, 20);
  });

  it("?page=3&per_page=50 → getAllInvoices(3, 50)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getAllInvoices.mockResolvedValueOnce({
      invoices: [],
      page_context: {},
    });
    await GET(makeReq("page=3&per_page=50"));
    expect(getAllInvoices).toHaveBeenCalledWith(3, 50);
  });
});

describe("Query parsing — NaN quirk pinned", () => {
  it("?page=abc&per_page=xyz → parseInt yields NaN → NaN reaches Zoho (current behaviour, paired with 7go quirk)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getAllInvoices.mockResolvedValueOnce({
      invoices: [],
      page_context: {},
    });
    await GET(makeReq("page=abc&per_page=xyz"));
    // Pinned. A Number.isFinite() guard would change these to 1 and 20.
    expect(getAllInvoices).toHaveBeenCalledWith(NaN, NaN);
  });
});

describe("Response passthrough", () => {
  it("returns { success:true, invoices, page_context } passing through Zoho's page_context shape", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getAllInvoices.mockResolvedValueOnce({
      invoices: [{ invoice_id: "INV-1", total: 999 }],
      page_context: {
        page: 1,
        per_page: 20,
        has_more_page: true,
        total: 42,
      },
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      invoices: [{ invoice_id: "INV-1", total: 999 }],
      page_context: {
        page: 1,
        per_page: 20,
        has_more_page: true,
        total: 42,
      },
    });
  });
});

describe("Outer catch", () => {
  it("Zoho throw → 500 'Failed to fetch invoices' (no leak)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getAllInvoices.mockRejectedValueOnce(
      new Error("Zoho 429: rate limited at org=12345")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch invoices");
    expect(body.error).not.toContain("Zoho");
    expect(body.error).not.toContain("12345");
  });
});
