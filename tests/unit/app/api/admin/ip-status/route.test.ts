/**
 * Tests for `app/api/admin/ip-status/route.ts` (slice 7gp, part 2).
 * Admin-only read of the latest IP whitelist status check. Powers
 * the admin dashboard widget that surfaces whether the DirectAdmin
 * whitelist still includes our Cloud Run egress IP.
 *
 * Pins:
 *  - **connectDB runs BEFORE auth gate** (current source order;
 *    pinned so a reorder that adds DB latency to unauth requests
 *    is flagged for review)
 *  - Admin gate via getAdminFromRequest → 401 'Unauthorized' on
 *    null (matches 7g6 / 7go-deactivated style — NOT 403)
 *  - **No-data response**: when getLatestIPCheck returns null, the
 *    handler still 200s with a stable shape (success:false,
 *    data:null, lastChecked:null, checkedBy:null) — the dashboard
 *    widget must NOT error on first-run / fresh DB state
 *  - Found: echoes success/message/data/error/lastChecked/
 *    checkedBy fields from the IPCheck doc (renamed checkedAt
 *    → lastChecked)
 *  - Outer catch → 500 generic 'Internal server error'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const getLatestIPCheck = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/ip-checks", () => ({ getLatestIPCheck }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/ip-status/route";

function makeReq() {
  return new NextRequest("https://example.com/api/admin/ip-status", {
    method: "GET",
  });
}

beforeEach(() => {
  getAdminFromRequest.mockReset();
  connectDB.mockClear().mockResolvedValue(undefined);
  getLatestIPCheck.mockReset();
});

// ─── connectDB ordering ──────────────────────────────────────────
describe("connectDB ordering", () => {
  it("connectDB called BEFORE the admin gate (current source order — pinned)", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    await GET(makeReq());
    // connectDB still called even though gate fails — this is the
    // current order. A reorder to gate-first would avoid the DB
    // call on unauth requests but would change this test.
    expect(connectDB).toHaveBeenCalled();
  });
});

// ─── Admin gate ─────────────────────────────────────────────────
describe("Admin gate", () => {
  it("non-admin → 401 'Unauthorized'; NO IP-check fetch", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(getLatestIPCheck).not.toHaveBeenCalled();
  });
});

// ─── No-data response ───────────────────────────────────────────
describe("No-data response (fresh DB / first-run)", () => {
  it("getLatestIPCheck null → 200 with stable {success:false, data:null, lastChecked:null, checkedBy:null} shape", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1", role: "admin" });
    getLatestIPCheck.mockResolvedValueOnce(null);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      message: "No IP check data available",
      data: null,
      lastChecked: null,
      checkedBy: null,
    });
  });
});

// ─── Found-data passthrough ─────────────────────────────────────
describe("Found-data passthrough", () => {
  it("IPCheck doc → fields echoed; checkedAt renamed to lastChecked", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1", role: "admin" });
    const checkedAt = new Date("2026-06-10T03:00:00.000Z");
    getLatestIPCheck.mockResolvedValueOnce({
      success: true,
      message: "IP 34.14.59.128 is whitelisted at all 4 layers",
      data: { ip: "34.14.59.128", layers: { csf: true, bfm: true } },
      error: null,
      checkedAt,
      checkedBy: "admin@example.com",
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message: "IP 34.14.59.128 is whitelisted at all 4 layers",
      data: { ip: "34.14.59.128", layers: { csf: true, bfm: true } },
      error: null,
      lastChecked: checkedAt.toISOString(),
      checkedBy: "admin@example.com",
    });
  });

  it("failed-check passthrough (success:false but data:null with error message)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1", role: "admin" });
    getLatestIPCheck.mockResolvedValueOnce({
      success: false,
      message: "Whitelist check failed",
      data: null,
      error: "BFM blocked",
      checkedAt: new Date("2026-06-10T03:00:00.000Z"),
      checkedBy: "cron@system",
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("BFM blocked");
    expect(body.message).toBe("Whitelist check failed");
  });
});

// ─── Outer catch ─────────────────────────────────────────────────
describe("Outer catch", () => {
  it("connectDB throws → 500 generic 'Internal server error' (no leak)", async () => {
    connectDB.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("Mongo timeout");
  });

  it("getLatestIPCheck throws → 500", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1", role: "admin" });
    getLatestIPCheck.mockRejectedValueOnce(new Error("DB blew up"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });
});
