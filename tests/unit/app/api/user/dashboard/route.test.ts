/**
 * Tests for `app/api/user/dashboard/route.ts` (slice 7gi). Customer-
 * facing dashboard aggregation feed. Three concerns to pin:
 *
 *   (a) Auth — dual-path (AuthService → NextAuth getToken with
 *       explicit cookie-name fallback). After getToken resolves a
 *       user, getUserById must confirm the row still exists AND is
 *       active. A deactivated account with a still-valid JWT must
 *       NOT reach the data layer.
 *   (b) IDOR — every service call (listOrdersForUser, listDomainsForUser,
 *       listActivePendingDomainsForUser, listHostingsForUser) is
 *       keyed on the resolved user._id; never on a request param.
 *   (c) Computed dashboard fields — exact contract pins so that a
 *       refactor of the aggregation logic can't quietly drift.
 *
 * Other pins:
 *  - 5-minute background-sync cooldown via touchHostingsLastSyncedForUser
 *    — if any hosting is older than 5 min (or never synced), enqueue a
 *    sync; failure to enqueue is SWALLOWED so the dashboard still loads
 *  - upcomingRenewals window is strictly (0, 30] days
 *  - 'terminated' services are filtered out of recentDomains
 *  - activeHostings is deduped by domainName (first wins)
 *  - outer catch → 500 DASHBOARD_LOAD_FAILED
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getToken = vi.hoisted(() => vi.fn());
vi.mock("next-auth/jwt", () => ({ getToken }));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET: "test-secret" }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const listOrdersForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ listOrdersForUser }));

const listDomainsForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/domains", () => ({ listDomainsForUser }));

const listActivePendingDomainsForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-domains", () => ({
  listActivePendingDomainsForUser,
}));

const listHostingsForUser = vi.hoisted(() => vi.fn());
const touchHostingsLastSyncedForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({
  listHostingsForUser,
  touchHostingsLastSyncedForUser,
}));

vi.mock("@/lib/directadmin", () => ({ DirectAdminService: {} }));

const createHttpTask = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cloud-tasks", () => ({ createHttpTask }));

vi.mock("@/lib/dateUtils", () => ({
  formatDateIN: (d: Date | string) =>
    new Date(d).toISOString().split("T")[0], // YYYY-MM-DD; stable for snapshot
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/user/dashboard/route";

const NOW = new Date("2026-06-08T12:00:00.000Z").getTime();

function makeReq() {
  return new NextRequest("https://example.com/api/user/dashboard", {
    method: "GET",
  });
}

const user = {
  _id: "U1",
  email: "alice@example.com",
  isActive: true,
};

const HOSTING_FRESH = {
  _id: "H1",
  domainName: "fresh.com",
  status: "active",
  name: "Starter",
  startDate: new Date("2026-01-01"),
  createdAt: new Date("2026-01-01"),
  expiryDate: new Date("2027-01-01"),
  lastSyncedAt: new Date(NOW - 60 * 1000), // 1 min ago — fresh
};

function happyServices() {
  listOrdersForUser.mockResolvedValue([]);
  listDomainsForUser.mockResolvedValue([]);
  listActivePendingDomainsForUser.mockResolvedValue([]);
  listHostingsForUser.mockResolvedValue([]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  getUserFromRequest.mockReset().mockResolvedValue(user);
  getToken.mockReset();
  getUserById.mockReset();
  listOrdersForUser.mockReset();
  listDomainsForUser.mockReset();
  listActivePendingDomainsForUser.mockReset();
  listHostingsForUser.mockReset();
  touchHostingsLastSyncedForUser.mockReset().mockResolvedValue(undefined);
  createHttpTask.mockReset().mockResolvedValue(undefined);
  process.env.GCP_QUEUE_NAME = "dms-default";
  process.env.NEXTAUTH_URL = "https://app.test";
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Auth ─────────────────────────────────────────────────────────
describe("Auth — dual-path", () => {
  it("AuthService returns user → no getToken fallback needed", async () => {
    happyServices();
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("AuthService null + getToken returns id → getUserById resolves the user", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U-JWT" });
    getUserById.mockResolvedValueOnce({
      _id: "U-JWT",
      email: "j@x.com",
      isActive: true,
    });
    happyServices();
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(getUserById).toHaveBeenCalledWith("U-JWT");
    expect(listOrdersForUser).toHaveBeenCalledWith(
      "U-JWT",
      expect.any(Object)
    );
  });

  it("getToken resolved user but isActive=false → 401 UNAUTHORIZED_USER_INVALID (no data fetch)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U-DEAD" });
    getUserById.mockResolvedValueOnce({
      _id: "U-DEAD",
      email: "d@x.com",
      isActive: false,
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED_USER_INVALID");
    expect(listOrdersForUser).not.toHaveBeenCalled();
  });

  it("getToken resolved but getUserById returns null → 401 UNAUTHORIZED_USER_INVALID", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U-DELETED" });
    getUserById.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED_USER_INVALID");
  });

  it("AuthService null + no token → 401 UNAUTHORIZED", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });
});

// ─── IDOR scope ───────────────────────────────────────────────────
describe("IDOR — every service call scoped by resolved user._id", () => {
  it("all 4 list calls use the SAME user._id from auth (not from request)", async () => {
    happyServices();
    await GET(makeReq());
    expect(listOrdersForUser).toHaveBeenCalledWith("U1", {
      limit: 0,
      populateUser: false,
    });
    expect(listDomainsForUser).toHaveBeenCalledWith("U1");
    expect(listActivePendingDomainsForUser).toHaveBeenCalledWith("U1");
    expect(listHostingsForUser).toHaveBeenCalledWith("U1", { limit: 0 });
  });
});

// ─── Stats: totals + recents ──────────────────────────────────────
describe("Stats — totals + recent slices", () => {
  it("totalDomains = registered domains + pending domains; activeDomains = registered count", async () => {
    listOrdersForUser.mockResolvedValue([]);
    listDomainsForUser.mockResolvedValue([
      { domainName: "a.com", status: "registered", createdAt: new Date(NOW - 1) },
      { domainName: "b.com", status: "registered", createdAt: new Date(NOW - 2) },
      { domainName: "c.com", status: "pending", createdAt: new Date(NOW - 3) },
    ]);
    listActivePendingDomainsForUser.mockResolvedValue([
      { domainName: "d.com", status: "pending", createdAt: new Date(NOW - 4) },
    ]);
    listHostingsForUser.mockResolvedValue([]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.stats.totalDomains).toBe(4); // 3 + 1
    expect(body.stats.activeDomains).toBe(2); // only 'registered'
    expect(body.stats.pendingDomains).toBe(1); // only the pending-domains collection
  });

  it("recentOrders capped at 5 and shaped {orderId, domains(count), amount, status, date}", async () => {
    const mk = (i: number) => ({
      orderId: `ORD-${i}`,
      domains: Array(i).fill({}),
      amount: 100 * i,
      status: "completed",
      createdAt: new Date(NOW - i * 1000),
    });
    listOrdersForUser.mockResolvedValue([1, 2, 3, 4, 5, 6, 7].map(mk));
    listDomainsForUser.mockResolvedValue([]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.stats.recentOrders).toHaveLength(5);
    expect(body.stats.recentOrders[0]).toEqual({
      orderId: "ORD-1",
      domains: 1,
      amount: 100,
      status: "completed",
      date: expect.any(String),
    });
  });

  it("totalOrders is full count, not capped to 5", async () => {
    const mk = (i: number) => ({
      orderId: `ORD-${i}`,
      domains: [],
      amount: 50,
      status: "completed",
      createdAt: new Date(NOW - i * 1000),
    });
    listOrdersForUser.mockResolvedValue(Array.from({ length: 12 }, (_, i) => mk(i)));
    listDomainsForUser.mockResolvedValue([]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.stats.totalOrders).toBe(12);
    expect(body.stats.recentOrders).toHaveLength(5);
  });
});

// ─── recentDomains + 'terminated' filter ──────────────────────────
describe("recentDomains — merged from domains + pending + hostings, filtered + sorted", () => {
  it("'terminated' services excluded from recentDomains", async () => {
    listOrdersForUser.mockResolvedValue([]);
    listDomainsForUser.mockResolvedValue([
      {
        domainName: "live.com",
        status: "registered",
        registeredAt: new Date(NOW - 86_400_000),
        createdAt: new Date(NOW - 86_400_000),
      },
    ]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([
      {
        _id: "H1",
        domainName: "killed.com",
        status: "terminated",
        startDate: new Date(NOW - 1000),
        createdAt: new Date(NOW - 1000),
        expiryDate: new Date(NOW - 1),
        lastSyncedAt: new Date(NOW - 1000),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(
      body.stats.recentDomains.map((d: { name: string }) => d.name)
    ).not.toContain("killed.com");
  });

  it("recentDomains sorted by registeredDate DESC and capped at 5", async () => {
    listOrdersForUser.mockResolvedValue([]);
    const mk = (i: number) => ({
      domainName: `d${i}.com`,
      status: "registered",
      registeredAt: new Date(NOW - i * 86_400_000), // newer = lower i
      createdAt: new Date(NOW - i * 86_400_000),
      expiresAt: new Date(NOW + i * 86_400_000),
    });
    listDomainsForUser.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => mk(i))
    );
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.stats.recentDomains).toHaveLength(5);
    expect(body.stats.recentDomains[0].name).toBe("d0.com");
    expect(body.stats.recentDomains[4].name).toBe("d4.com");
  });
});

// ─── upcomingRenewals window ──────────────────────────────────────
describe("upcomingRenewals — strict (0, 30] day window, sorted asc, capped at 5", () => {
  it("includes daysLeft = 30 (boundary), excludes 31 and 0", async () => {
    listOrdersForUser.mockResolvedValue([]);
    const day = 86_400_000;
    listDomainsForUser.mockResolvedValue([
      {
        domainName: "in30.com",
        status: "registered",
        registeredAt: new Date(NOW),
        createdAt: new Date(NOW),
        expiresAt: new Date(NOW + 30 * day),
      },
      {
        domainName: "in31.com",
        status: "registered",
        registeredAt: new Date(NOW),
        createdAt: new Date(NOW),
        expiresAt: new Date(NOW + 31 * day),
      },
      {
        domainName: "expired.com",
        status: "registered",
        registeredAt: new Date(NOW),
        createdAt: new Date(NOW),
        expiresAt: new Date(NOW - 1 * day),
      },
    ]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([]);

    const res = await GET(makeReq());
    const body = await res.json();
    const names = body.stats.upcomingRenewals.map(
      (r: { domain: string }) => r.domain
    );
    expect(names).toContain("in30.com");
    expect(names).not.toContain("in31.com");
    expect(names).not.toContain("expired.com");
  });

  it("hosting active + future expiry included alongside domains", async () => {
    listOrdersForUser.mockResolvedValue([]);
    const day = 86_400_000;
    listDomainsForUser.mockResolvedValue([]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([
      {
        _id: "H1",
        domainName: "host.com",
        status: "active",
        name: "Starter",
        startDate: new Date(NOW),
        createdAt: new Date(NOW),
        expiryDate: new Date(NOW + 15 * day),
        lastSyncedAt: new Date(NOW - 1000),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.stats.upcomingRenewals).toHaveLength(1);
    expect(body.stats.upcomingRenewals[0]).toEqual(
      expect.objectContaining({
        domain: "host.com",
        type: "Hosting",
        daysLeft: 15,
      })
    );
  });
});

// ─── activeHostings dedup ─────────────────────────────────────────
describe("activeHostings — dedup by domainName; only status:'active'", () => {
  it("dedup keeps the first occurrence", async () => {
    listOrdersForUser.mockResolvedValue([]);
    listDomainsForUser.mockResolvedValue([]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([
      {
        _id: "H_KEEP",
        domainName: "dup.com",
        status: "active",
        name: "First",
        startDate: new Date(NOW),
        createdAt: new Date(NOW),
        expiryDate: new Date(NOW + 86_400_000),
        lastSyncedAt: new Date(NOW - 1000),
      },
      {
        _id: "H_DROP",
        domainName: "dup.com",
        status: "active",
        name: "Second",
        startDate: new Date(NOW),
        createdAt: new Date(NOW),
        expiryDate: new Date(NOW + 86_400_000),
        lastSyncedAt: new Date(NOW - 1000),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.stats.activeHostings).toHaveLength(1);
    expect(body.stats.activeHostings[0].id).toBe("H_KEEP");
    expect(body.stats.activeHostings[0].package).toBe("First");
  });

  it("excludes non-'active' hosting from activeHostings", async () => {
    listOrdersForUser.mockResolvedValue([]);
    listDomainsForUser.mockResolvedValue([]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([
      {
        _id: "H1",
        domainName: "suspended.com",
        status: "suspended",
        name: "X",
        startDate: new Date(NOW),
        createdAt: new Date(NOW),
        expiryDate: new Date(NOW + 86_400_000),
        lastSyncedAt: new Date(NOW - 1000),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.stats.activeHostings).toHaveLength(0);
  });
});

// ─── Background sync (5-min cooldown) ─────────────────────────────
describe("Background sync (5-min cooldown)", () => {
  it("any hosting older than 5min → createHttpTask enqueued; touchHostingsLastSyncedForUser stamped", async () => {
    listOrdersForUser.mockResolvedValue([]);
    listDomainsForUser.mockResolvedValue([]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([
      { ...HOSTING_FRESH, lastSyncedAt: new Date(NOW - 6 * 60 * 1000) },
    ]);

    await GET(makeReq());
    expect(createHttpTask).toHaveBeenCalledWith(
      "dms-default",
      "https://app.test/api/v1/workers/sync-hosting-status",
      { userId: "U1" }
    );
    expect(touchHostingsLastSyncedForUser).toHaveBeenCalledWith("U1");
  });

  it("all hostings synced within 5min → NO task enqueued", async () => {
    listOrdersForUser.mockResolvedValue([]);
    listDomainsForUser.mockResolvedValue([]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([
      { ...HOSTING_FRESH, lastSyncedAt: new Date(NOW - 60 * 1000) },
    ]);

    await GET(makeReq());
    expect(createHttpTask).not.toHaveBeenCalled();
    expect(touchHostingsLastSyncedForUser).not.toHaveBeenCalled();
  });

  it("hosting with NO lastSyncedAt → counts as needs-sync", async () => {
    listOrdersForUser.mockResolvedValue([]);
    listDomainsForUser.mockResolvedValue([]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([
      { ...HOSTING_FRESH, lastSyncedAt: undefined },
    ]);

    await GET(makeReq());
    expect(createHttpTask).toHaveBeenCalled();
  });

  it("zero hostings → no sync attempt", async () => {
    happyServices();
    await GET(makeReq());
    expect(createHttpTask).not.toHaveBeenCalled();
  });

  it("createHttpTask throw SWALLOWED — dashboard still renders", async () => {
    listOrdersForUser.mockResolvedValue([]);
    listDomainsForUser.mockResolvedValue([]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([
      { ...HOSTING_FRESH, lastSyncedAt: new Date(NOW - 6 * 60 * 1000) },
    ]);
    createHttpTask.mockRejectedValueOnce(new Error("Cloud Tasks down"));

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });
});

// ─── serviceStatus flags ──────────────────────────────────────────
describe("serviceStatus flags", () => {
  it("hasDomains true when domains.length > 0; hasHosting true when hostings.length > 0", async () => {
    listOrdersForUser.mockResolvedValue([]);
    listDomainsForUser.mockResolvedValue([{ domainName: "x.com", status: "registered", createdAt: new Date(NOW) }]);
    listActivePendingDomainsForUser.mockResolvedValue([]);
    listHostingsForUser.mockResolvedValue([
      { ...HOSTING_FRESH, lastSyncedAt: new Date(NOW - 60 * 1000) },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.serviceStatus).toEqual({
      hasDomains: true,
      hasHosting: true,
    });
  });

  it("both false when both arrays empty", async () => {
    happyServices();
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.serviceStatus).toEqual({
      hasDomains: false,
      hasHosting: false,
    });
  });
});

// ─── Outer catch ──────────────────────────────────────────────────
describe("Outer catch", () => {
  it("any service throw → 500 DASHBOARD_LOAD_FAILED", async () => {
    listOrdersForUser.mockRejectedValueOnce(new Error("DB down"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DASHBOARD_LOAD_FAILED");
  });
});
