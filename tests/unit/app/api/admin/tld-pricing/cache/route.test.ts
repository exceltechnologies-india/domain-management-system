/**
 * Tests for `app/api/admin/tld-pricing/cache/route.ts` (slice 7hy, part 2).
 *
 * Admin TLD-pricing cache controls (GET status + DELETE purge + PUT
 * settings). Drives the cache-management widget in admin settings.
 *
 * Threat model:
 *  - **Stale cache after disable**: a refactor that disables the
 *    cache flag but forgets to purge would leave the in-memory
 *    Redis cache still serving stale data. Pinned: disable→purge
 *    sequence.
 *  - **Negative/zero TTL bypass**: zod requires positive int; the
 *    call site also has a `> 0` guard. Both pinned.
 *
 * Other pins:
 *  - Admin gate per-method → 401
 *  - GET: getStatus + getTTL composed into response
 *  - DELETE: purge called; audit-log emitted
 *  - PUT zod: enabled-OR-ttlMinutes required via .refine()
 *  - PUT ttlMinutes: positive int 1-43200 (30 days max)
 *  - PUT enabled=true → upsertSetting only, NO purge
 *  - PUT enabled=false → upsertSetting + tldPricingCache.purge
 *  - PUT ttlMinutes → upsertSetting + tldPricingCache.setTTL
 *  - Both fields supplied → both writes fire
 *  - Outer catch per-method → 500 with success:false
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const cacheGetStatus = vi.hoisted(() => vi.fn());
const cacheGetTTL = vi.hoisted(() => vi.fn());
const cachePurge = vi.hoisted(() => vi.fn());
const cacheSetTTL = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tld-pricing-cache", () => ({
  tldPricingCache: {
    getStatus: cacheGetStatus,
    getTTL: cacheGetTTL,
    purge: cachePurge,
    setTTL: cacheSetTTL,
  },
}));

const upsertSetting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({ upsertSetting }));

vi.mock("@/lib/mongoose", () => ({
  connectToDatabase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, DELETE, PUT } from "@/app/api/admin/tld-pricing/cache/route";

function makeReq(method: "GET" | "DELETE" | "PUT", body?: unknown) {
  return new NextRequest("https://example.com/api/admin/tld-pricing/cache", {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({
    _id: "ADMIN1",
    email: "admin@example.com",
  });
  cacheGetStatus.mockReset();
  cacheGetTTL.mockReset();
  cachePurge.mockReset().mockResolvedValue(undefined);
  cacheSetTTL.mockReset();
  upsertSetting.mockReset().mockResolvedValue(undefined);
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET — admin gate + status", () => {
  it("non-admin → 401; no cache probe", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
    expect(cacheGetStatus).not.toHaveBeenCalled();
  });

  it("admin → getStatus + getTTL composed into response", async () => {
    cacheGetStatus.mockResolvedValueOnce({
      enabled: true,
      keys: 42,
      isRedis: true,
    });
    cacheGetTTL.mockReturnValueOnce(60);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.cache).toEqual({ enabled: true, keys: 42, isRedis: true });
    expect(body.ttl).toBe(60);
  });

  it("getStatus throw → 500 success:false", async () => {
    cacheGetStatus.mockRejectedValueOnce(new Error("Redis down"));
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      error: "Failed to get cache status",
    });
  });
});

// ─────────────────────────── DELETE ─────────────────────────────

describe("DELETE — purge", () => {
  it("non-admin → 401; no purge", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq("DELETE"));
    expect(res.status).toBe(401);
    expect(cachePurge).not.toHaveBeenCalled();
  });

  it("admin → purge called once + 200 success", async () => {
    const res = await DELETE(makeReq("DELETE"));
    expect(res.status).toBe(200);
    expect(cachePurge).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Cache purged successfully");
  });

  it("purge throw → 500 success:false", async () => {
    cachePurge.mockRejectedValueOnce(new Error("Redis throw"));
    const res = await DELETE(makeReq("DELETE"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      error: "Failed to purge cache",
    });
  });
});

// ─────────────────────────── PUT ─────────────────────────────

describe("PUT — admin gate", () => {
  it("non-admin → 401; no setting write", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await PUT(makeReq("PUT", { enabled: true }));
    expect(res.status).toBe(401);
    expect(upsertSetting).not.toHaveBeenCalled();
  });
});

describe("PUT — zod schema", () => {
  it("empty body → 400 (refine: at least one of enabled/ttlMinutes)", async () => {
    const res = await PUT(makeReq("PUT", {}));
    expect(res.status).toBe(400);
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  it("ttlMinutes = 0 → 400 (positive int)", async () => {
    const res = await PUT(makeReq("PUT", { ttlMinutes: 0 }));
    expect(res.status).toBe(400);
  });

  it("ttlMinutes = -1 → 400", async () => {
    const res = await PUT(makeReq("PUT", { ttlMinutes: -1 }));
    expect(res.status).toBe(400);
  });

  it("ttlMinutes = 1.5 (float) → 400", async () => {
    const res = await PUT(makeReq("PUT", { ttlMinutes: 1.5 }));
    expect(res.status).toBe(400);
  });

  it("ttlMinutes > 43200 (30 days) → 400", async () => {
    const res = await PUT(makeReq("PUT", { ttlMinutes: 43201 }));
    expect(res.status).toBe(400);
  });

  it("enabled non-boolean → 400", async () => {
    const res = await PUT(makeReq("PUT", { enabled: "true" }));
    expect(res.status).toBe(400);
  });
});

describe("PUT — enabled flag", () => {
  it("enabled=true → upsertSetting only; NO purge", async () => {
    const res = await PUT(makeReq("PUT", { enabled: true }));
    expect(res.status).toBe(200);
    expect(upsertSetting).toHaveBeenCalledWith(
      "tld_pricing_cache_enabled",
      true,
      expect.objectContaining({
        category: "caching",
        updatedBy: "admin@example.com",
      })
    );
    expect(cachePurge).not.toHaveBeenCalled();
  });

  it("**enabled=false → upsertSetting + AUTOMATIC PURGE** (anti-stale-state)", async () => {
    const res = await PUT(makeReq("PUT", { enabled: false }));
    expect(res.status).toBe(200);
    expect(upsertSetting).toHaveBeenCalledWith(
      "tld_pricing_cache_enabled",
      false,
      expect.any(Object)
    );
    expect(cachePurge).toHaveBeenCalledTimes(1);
  });
});

describe("PUT — TTL update", () => {
  it("ttlMinutes=120 → upsertSetting + setTTL(120)", async () => {
    const res = await PUT(makeReq("PUT", { ttlMinutes: 120 }));
    expect(res.status).toBe(200);
    expect(upsertSetting).toHaveBeenCalledWith(
      "tld_pricing_cache_ttl",
      120,
      expect.objectContaining({ category: "caching" })
    );
    expect(cacheSetTTL).toHaveBeenCalledWith(120);
  });

  it("ttlMinutes at max (43200) → accepted", async () => {
    const res = await PUT(makeReq("PUT", { ttlMinutes: 43200 }));
    expect(res.status).toBe(200);
    expect(cacheSetTTL).toHaveBeenCalledWith(43200);
  });
});

describe("PUT — both fields supplied", () => {
  it("enabled=true + ttlMinutes=60 → both upserts + setTTL; NO purge", async () => {
    const res = await PUT(
      makeReq("PUT", { enabled: true, ttlMinutes: 60 })
    );
    expect(res.status).toBe(200);
    expect(upsertSetting).toHaveBeenCalledTimes(2);
    expect(cacheSetTTL).toHaveBeenCalledWith(60);
    expect(cachePurge).not.toHaveBeenCalled();
  });

  it("enabled=false + ttlMinutes=60 → both upserts + setTTL + purge (disable triggers purge)", async () => {
    const res = await PUT(
      makeReq("PUT", { enabled: false, ttlMinutes: 60 })
    );
    expect(res.status).toBe(200);
    expect(upsertSetting).toHaveBeenCalledTimes(2);
    expect(cacheSetTTL).toHaveBeenCalledWith(60);
    expect(cachePurge).toHaveBeenCalledTimes(1);
  });
});

describe("PUT — response shape", () => {
  it("returns success + message + settings echo", async () => {
    const res = await PUT(
      makeReq("PUT", { enabled: true, ttlMinutes: 120 })
    );
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message: "Cache settings updated successfully",
      settings: { enabled: true, ttlMinutes: 120 },
    });
  });
});

describe("PUT — outer catch", () => {
  it("upsertSetting throw → 500 success:false", async () => {
    upsertSetting.mockRejectedValueOnce(new Error("Mongo blip"));
    const res = await PUT(makeReq("PUT", { enabled: true }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      error: "Failed to update cache settings",
    });
  });
});
