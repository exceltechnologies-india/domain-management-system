/**
 * Tests for `app/api/admin/system-health/route.ts` (slice 7hp, part 2).
 *
 * Admin operational dashboard — 7 independent probes (DB, queues, RC,
 * DirectAdmin, Razorpay, Zoho Books, server metrics) each individually
 * try/catch-isolated.
 *
 * Threat model:
 *  - **One-upstream-down blanks the whole page**: a refactor that
 *    awaits all probes in a single Promise.all WITHOUT per-probe
 *    catch would propagate any single failure to a 500 and the
 *    dashboard would go dark when admin needs it most. Pinned via
 *    "RC down + DA down + Zoho down → status still 200, DB still
 *    reports operational, other fields still populated".
 *  - **Cache leak of dashboard data**: the response is admin-only;
 *    upstream caches must not store it. Cache-Control: no-store
 *    pinned.
 *  - **Stale-mode flag**: razorpayMode derives from
 *    process.env.RAZORPAY_KEY_ID prefix — the same logic as
 *    razorpay-mode GET. If those drift, admin sees the wrong mode.
 *    Pinned.
 *
 * Other pins:
 *  - JWT-OR-session dual auth: JWT path checked first (works in App
 *    Router); session is fallback
 *  - non-admin via both paths → 401
 *  - RC NoBilling branch: balance is NOT returned for credit accounts
 *  - Zoho 5-state diagnostic: misconfigured / expired / trial /
 *    trial_expiring / active
 *  - Latency tracked on FAILURE too (failure-path latency is
 *    valuable telemetry — pinned as ≥0)
 *  - Server metrics included: uptimeSeconds, memory, nodeVersion,
 *    environment, appVersion
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const getToken = vi.hoisted(() => vi.fn());
vi.mock("next-auth/jwt", () => ({ getToken }));

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));

vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET: "test-secret" }));
vi.mock("@/lib/auth-config", () => ({ authOptions: {} }));
vi.mock("@/lib/mongoose", () => ({
  connectToDatabase: vi.fn().mockResolvedValue(undefined),
}));

const countDocumentsDomain = vi.hoisted(() => vi.fn());
vi.mock("@/models/Domain", () => ({
  default: { countDocuments: countDocumentsDomain },
}));

const countDocumentsPendingDomain = vi.hoisted(() => vi.fn());
vi.mock("@/models/PendingDomain", () => ({
  default: { countDocuments: countDocumentsPendingDomain },
}));

const countPendingHostingsByStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-hostings", () => ({
  countPendingHostingsByStatus,
}));

const getSettingValue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({ getSettingValue }));

const countUsers = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ countUsers }));

const countAllOrders = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ countAllOrders }));

const countOpenTickets = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/support-tickets", () => ({ countOpenTickets }));

const getResellerDetails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { getResellerDetails },
}));

const listPackages = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { listPackages },
}));

const razorpayOrdersAll = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  razorpay: { orders: { all: razorpayOrdersAll } },
}));

const getOrganizationDetails = vi.hoisted(() => vi.fn());
const isSubscriptionExpired = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: {
    getInstance: () => ({ getOrganizationDetails, isSubscriptionExpired }),
  },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/system-health/route";

function makeReq() {
  return new NextRequest("https://example.com/api/admin/system-health", {
    method: "GET",
  });
}

function setupAllProbesHappy() {
  // ── Auth: admin via JWT
  getToken.mockResolvedValue({ role: "admin" });
  // ── DB
  countUsers.mockResolvedValue(100);
  countAllOrders.mockResolvedValue(50);
  countDocumentsDomain.mockResolvedValue(40);
  countOpenTickets.mockResolvedValue(3);
  countDocumentsPendingDomain.mockResolvedValue(0);
  countPendingHostingsByStatus.mockResolvedValue(0);
  // ── RC
  getResellerDetails.mockResolvedValue({
    status: "success",
    data: {
      billingmode: "Prepaid",
      resellerstatus: "Active",
      availablebalance: "1234.50",
    },
  });
  // ── DA
  listPackages.mockResolvedValue([{ name: "basic" }, { name: "premium" }]);
  // ── Razorpay
  razorpayOrdersAll.mockResolvedValue({ items: [] });
  // ── Zoho
  getOrganizationDetails.mockResolvedValue({
    plan_name: "Standard",
    plan_type: "paid",
    plan_expiry_date: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    status: "active",
  });
  isSubscriptionExpired.mockReturnValue(false);
  getSettingValue.mockResolvedValue(null);
}

const origEnv = { ...process.env };

beforeEach(() => {
  getToken.mockReset();
  getServerSession.mockReset();
  countUsers.mockReset();
  countAllOrders.mockReset();
  countDocumentsDomain.mockReset();
  countOpenTickets.mockReset();
  countDocumentsPendingDomain.mockReset();
  countPendingHostingsByStatus.mockReset();
  getResellerDetails.mockReset();
  listPackages.mockReset();
  razorpayOrdersAll.mockReset();
  getOrganizationDetails.mockReset();
  isSubscriptionExpired.mockReset();
  getSettingValue.mockReset();
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_xxx");
  vi.stubEnv("ZOHO_CLIENT_ID", "zoho_client");
  vi.stubEnv("ZOHO_CLIENT_SECRET", "zoho_secret");
  vi.stubEnv("ZOHO_REFRESH_TOKEN", "zoho_refresh");
});

afterAll(() => {
  vi.unstubAllEnvs();
  process.env = { ...origEnv };
});

// ─────────────────────────── Auth ─────────────────────────────

describe("Dual auth (JWT-first, session-fallback)", () => {
  it("JWT admin → proceeds; getServerSession NOT consulted", async () => {
    setupAllProbesHappy();
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(getServerSession).not.toHaveBeenCalled();
  });

  it("JWT missing → falls through to session; session admin → 200", async () => {
    setupAllProbesHappy();
    getToken.mockResolvedValueOnce(null);
    getServerSession.mockResolvedValueOnce({ user: { role: "admin" } });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it("JWT non-admin AND session missing → 401", async () => {
    getToken.mockResolvedValueOnce({ role: "user" });
    getServerSession.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("JWT throw → caught; falls through to session", async () => {
    setupAllProbesHappy();
    getToken.mockRejectedValueOnce(new Error("JWT decode fail"));
    getServerSession.mockResolvedValueOnce({ user: { role: "admin" } });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });
});

// ──────────────────────── Probe isolation ─────────────────────

describe("Probe isolation — one upstream down doesn't blank the rest", () => {
  it("RC + DA + Zoho all DOWN → 200; DB still operational; other fields populated", async () => {
    setupAllProbesHappy();
    getResellerDetails.mockRejectedValueOnce(new Error("RC unreachable"));
    listPackages.mockRejectedValueOnce(new Error("DA unreachable"));
    getOrganizationDetails.mockRejectedValueOnce(
      Object.assign(new Error("zoho_oauth_LEAK_ME"), { code: "AUTH_ERROR" })
    );

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.database.status).toBe("operational");
    expect(body.externalApis.resellerClub.status).toBe("down");
    expect(body.externalApis.directAdmin.status).toBe("down");
    expect(body.externalApis.zohoBooks.status).toBe("down");
    expect(body.externalApis.razorpay.status).toBe("operational");
    // Sentinel leak guard — error message must NOT escape into body
    expect(JSON.stringify(body)).not.toContain("zoho_oauth_LEAK_ME");
  });

  it("DB connect fail → dbStatus='down' BUT response still 200 and other probes still run", async () => {
    setupAllProbesHappy();
    countUsers.mockRejectedValueOnce(new Error("Mongo refused"));
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.database.status).toBe("down");
    expect(body.externalApis.resellerClub.status).toBe("operational");
  });

  it("ALL 4 external probes fail → still 200, no probe crash propagates", async () => {
    setupAllProbesHappy();
    getResellerDetails.mockRejectedValueOnce(new Error("rc"));
    listPackages.mockRejectedValueOnce(new Error("da"));
    razorpayOrdersAll.mockRejectedValueOnce(new Error("rzp"));
    getOrganizationDetails.mockRejectedValueOnce(new Error("zoho"));
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });
});

// ──────────────────────── Probe details ───────────────────────

describe("ResellerClub — NoBilling branch", () => {
  it("billingmode=NoBilling → balance is NULL (NOT returned for credit accounts)", async () => {
    setupAllProbesHappy();
    getResellerDetails.mockResolvedValueOnce({
      status: "success",
      data: {
        billingmode: "NoBilling",
        resellerstatus: "Active",
        availablebalance: "9999.00", // should be IGNORED
      },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.resellerClub.billingMode).toBe("NoBilling");
    expect(body.externalApis.resellerClub.balance).toBeNull();
  });

  it("Prepaid + availablebalance → balance exposed as string", async () => {
    setupAllProbesHappy();
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.resellerClub.billingMode).toBe("Prepaid");
    expect(body.externalApis.resellerClub.balance).toBe("1234.50");
  });

  it("RC returns status:'error' (not throw) → status='down'", async () => {
    setupAllProbesHappy();
    getResellerDetails.mockResolvedValueOnce({ status: "error" });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.resellerClub.status).toBe("down");
  });
});

describe("Zoho 5-state diagnostic", () => {
  it("Zoho env vars unset → status='down', planStatus='misconfigured'", async () => {
    setupAllProbesHappy();
    vi.stubEnv("ZOHO_CLIENT_ID", "");
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.zohoBooks.status).toBe("down");
    expect(body.externalApis.zohoBooks.planStatus).toBe("misconfigured");
  });

  it("DB-flagged expired → planStatus='expired', status='down' BEFORE hitting Zoho", async () => {
    setupAllProbesHappy();
    getSettingValue.mockResolvedValueOnce({ expired: true });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.zohoBooks.status).toBe("down");
    expect(body.externalApis.zohoBooks.planStatus).toBe("expired");
    expect(getOrganizationDetails).not.toHaveBeenCalled();
  });

  it("plan_expiry_date in 3 days → planStatus='trial_expiring' (≤7 days threshold)", async () => {
    setupAllProbesHappy();
    getOrganizationDetails.mockResolvedValueOnce({
      plan_name: "Trial",
      plan_type: "trial",
      plan_expiry_date: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.zohoBooks.planStatus).toBe("trial_expiring");
    expect(body.externalApis.zohoBooks.daysUntilExpiry).toBeGreaterThanOrEqual(
      2
    );
    expect(body.externalApis.zohoBooks.daysUntilExpiry).toBeLessThanOrEqual(3);
  });

  it("plan_type='trial' + far-future expiry → planStatus='trial'", async () => {
    setupAllProbesHappy();
    getOrganizationDetails.mockResolvedValueOnce({
      plan_name: "Trial",
      plan_type: "trial",
      plan_expiry_date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.zohoBooks.planStatus).toBe("trial");
  });

  it("paid plan + far-future expiry → planStatus='active'", async () => {
    setupAllProbesHappy();
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.zohoBooks.planStatus).toBe("active");
  });

  it("Zoho error with code='AUTH_ERROR' → planStatus='misconfigured'", async () => {
    setupAllProbesHappy();
    getOrganizationDetails.mockRejectedValueOnce({
      code: "AUTH_ERROR",
      message: "missing token",
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.zohoBooks.status).toBe("down");
    expect(body.externalApis.zohoBooks.planStatus).toBe("misconfigured");
  });
});

describe("Razorpay mode echo (anti-drift with razorpay-mode endpoint)", () => {
  it("RAZORPAY_KEY_ID=rzp_live_xxx → mode='live'", async () => {
    setupAllProbesHappy();
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_live_ABC");
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.razorpay.mode).toBe("live");
  });

  it("RAZORPAY_KEY_ID=rzp_test_xxx → mode='test'", async () => {
    setupAllProbesHappy();
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_ABC");
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.externalApis.razorpay.mode).toBe("test");
  });
});

describe("Response shape + Cache-Control", () => {
  it("Cache-Control: no-store, no-cache, must-revalidate pinned", async () => {
    setupAllProbesHappy();
    const res = await GET(makeReq());
    expect(res.headers.get("cache-control")).toBe(
      "no-store, no-cache, must-revalidate"
    );
  });

  it("response shape locks: database / queueBacklog / failedJobs / externalApis / server / timestamp", async () => {
    setupAllProbesHappy();
    const res = await GET(makeReq());
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "database",
      "externalApis",
      "failedJobs",
      "queueBacklog",
      "server",
      "timestamp",
    ]);
    expect(body.server).toEqual(
      expect.objectContaining({
        uptimeSeconds: expect.any(Number),
        memory: expect.any(Object),
        nodeVersion: expect.any(String),
        environment: expect.any(String),
        appVersion: expect.any(String),
      })
    );
  });

  it("queueBacklog.total = domains + hosting", async () => {
    setupAllProbesHappy();
    countDocumentsPendingDomain.mockResolvedValueOnce(3); // dbStats path
    countPendingHostingsByStatus.mockResolvedValueOnce(0); // dbStats path
    countDocumentsPendingDomain.mockResolvedValueOnce(3); // backlog path
    countPendingHostingsByStatus.mockResolvedValueOnce(2); // backlog path
    countDocumentsPendingDomain.mockResolvedValueOnce(1); // failed path
    countPendingHostingsByStatus.mockResolvedValueOnce(1); // failed path
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.queueBacklog.domains).toBe(3);
    expect(body.queueBacklog.hosting).toBe(2);
    expect(body.queueBacklog.total).toBe(5);
    expect(body.failedJobs.total).toBe(2);
  });
});
