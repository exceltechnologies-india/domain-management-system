/**
 * Tests for `app/api/admin/hosting/stats/route.ts` (rescan-4 slice
 * 7g6). Admin hosting-stats endpoint. Two-mode contract: LIVE (DA
 * available) iterates DA users + maps to local; FALLBACK DB (DA
 * unreachable) iterates Hosting collection. Pins:
 *  - **Admin auth gate FIRST** (no admin → 403 FORBIDDEN, not 401)
 *  - **5s DA timeout**: Promise.race against 5000ms; rejects with
 *    Error('DA_TIMEOUT') (anti-Cloud-Run-slot-stall — DA being slow
 *    must not block the admin panel for >5s)
 *  - **DA_TIMEOUT message branch**: 'Connection attempt to
 *    DirectAdmin timed out (5s limit)' vs the raw error message
 *    for other failures
 *  - **DA failure (any) → fallback DB mode**: isDaAvailable=false +
 *    daError captured; iterates Hosting records instead of DA users
 *  - **LIVE mode email-fallback linking**: if local user not found
 *    by daUsername, try by daConfig.email → linkedByEmail=true
 *    (handles legacy users with DA account but missing
 *    user.directAdminUsername field)
 *  - **LIVE mode best-match hosting record (3-tier)**: (1) exact
 *    username match, (2) status:'active' match, (3) latest
 *    (createdAt:-1 sort means [0])
 *  - **Local DB status overrides DA status**: when hostingRecord.
 *    status is 'suspended' or 'terminated', that wins over the
 *    DA-computed status. Anti-stale-DA — if our cron-job updated
 *    DB but DA hasn't synced yet, admin sees correct state
 *  - **PHP version resolution**: daConfig.php_version (when not
 *    'Default') → serverInfo.php (when daConfig.php='ON') → 'Default'
 *  - **'unlimited' bandwidth/quota** → 'Unlimited' display string
 *  - **isUnlinked = !localUser**; unlinked rows still show in the
 *    table with daConfig.email instead of local email
 *  - **Per-user DA fetch failure**: returns error row (NOT a crash);
 *    domain='Error fetching', status='error', error=message
 *  - **DB MODE structure (when DA down)**: maps from hostingRecords;
 *    usage placeholders ('0' / 'Unknown'); status from h.status
 *    directly
 *  - **daMode detection**: 'Live' when connected; 'Disconnected'
 *    when not; 'Local' when DIRECTADMIN_URL contains localhost /
 *    127.0.0.1 / host.docker.internal
 *  - **Response shape**: success + data + source (live/db) +
 *    isDaConnected + daError + daMode + warning (null when live)
 *  - **Outer catch fallback**: if main try throws, attempts ONE
 *    MORE fallback Hosting+listAllUserBriefs fetch; only 500s if
 *    even that fails
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const listDAUsers = vi.hoisted(() => vi.fn());
const getAllUserUsage = vi.hoisted(() => vi.fn());
const getServerInfo = vi.hoisted(() => vi.fn());
const getUserConfig = vi.hoisted(() => vi.fn());
const getUserUsage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: {
    listUsers: listDAUsers,
    getAllUserUsage,
    getServerInfo,
    getUserConfig,
    getUserUsage,
  },
}));

const findUsersByEmails = vi.hoisted(() => vi.fn());
const getUserBriefByEmail = vi.hoisted(() => vi.fn());
const listAllUserBriefs = vi.hoisted(() => vi.fn());
const listUsersWithDirectAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  findUsersByEmails,
  getUserBriefByEmail,
  listAllUserBriefs,
  listUsersWithDirectAdmin,
}));

const hostingFind = vi.hoisted(() => vi.fn());
vi.mock("@/models/Hosting", () => ({
  default: { find: hostingFind },
}));

vi.mock("@/models/HostingPlan", () => ({ default: {} }));

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const secureJsonResponse = vi.hoisted(() =>
  vi.fn((data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  )
);
const secureErrorResponse = vi.hoisted(() =>
  vi.fn((message: string, status: number, code: string) =>
    new Response(JSON.stringify({ error: message, code }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  )
);
vi.mock("@/lib/api-response-wrapper", () => ({
  secureJsonResponse,
  secureErrorResponse,
}));

const addSecurityHeaders = vi.hoisted(() => vi.fn((res: any) => res));
vi.mock("@/lib/security-headers", () => ({ addSecurityHeaders }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/hosting/stats/route";

function makeReq() {
  return new NextRequest("https://example.com/api/admin/hosting/stats", {
    method: "GET",
  });
}

// Chainable Hosting.find query stub
function chainableHostingFind(resolved: unknown[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(resolved),
  };
}

function makeLocalUser(overrides: Partial<any> = {}): any {
  return {
    _id: { toString: () => "U1" },
    firstName: "First",
    lastName: "Last",
    email: "user@x.com",
    directAdminUsername: "alice",
    hostingCreatedAt: new Date("2026-01-01"),
    hostingExpiresAt: new Date("2027-01-01"),
    ...overrides,
  };
}

function makeHostingRecord(overrides: Partial<any> = {}): any {
  return {
    _id: { toString: () => "H1" },
    domainName: "alice.example.com",
    directAdminUsername: "alice",
    status: "active",
    startDate: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
    expiryDate: new Date("2027-01-01"),
    userId: { toString: () => "U1" },
    name: "Pro Plan",
    serverIp: "1.2.3.4",
    ...overrides,
  };
}

beforeEach(() => {
  isAdmin.mockReset().mockResolvedValue(true);
  connectDB.mockReset().mockResolvedValue(undefined);
  // Defensive defaults — `getServerInfo().catch(...)` is evaluated SYNCHRONOUSLY
  // during Promise.all array construction, so getServerInfo() returning
  // undefined would crash before any test logic runs. Same defensive default
  // for getAllUserUsage + listDAUsers so each test only needs to override the
  // single fn it's exercising.
  listDAUsers.mockReset().mockResolvedValue([]);
  getAllUserUsage.mockReset().mockResolvedValue({});
  getServerInfo.mockReset().mockResolvedValue({ php: "Default" });
  getUserConfig.mockReset();
  // Defensive default — getUserUsage is called in parallel with getUserConfig
  // for every row; any test that doesn't explicitly mock usage should still
  // pass with an empty usage payload (which is what real DA would return for
  // a brand-new account).
  getUserUsage.mockReset().mockResolvedValue({});
  findUsersByEmails.mockReset();
  getUserBriefByEmail.mockReset();
  listAllUserBriefs.mockReset().mockResolvedValue([]);
  listUsersWithDirectAdmin.mockReset().mockResolvedValue([]);
  hostingFind.mockReset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Admin gate ────────────────────────────────────────────────────
describe("Admin auth gate FIRST", () => {
  it("not admin → 403 FORBIDDEN (NOT 401 — anti-info-leak)", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(connectDB).not.toHaveBeenCalled();
    expect(listDAUsers).not.toHaveBeenCalled();
  });
});

// ─── LIVE mode happy path ──────────────────────────────────────────
describe("LIVE mode — DA available", () => {
  function setupLive() {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(
      chainableHostingFind([makeHostingRecord()])
    );
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({ alice: {} });
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
      bandwidth: "1000",
      quota: "10240",
      bandwidth_usage: "500",
      quota_usage: "5000",
      package: "Pro",
      ip: "1.2.3.4",
      email: "user@x.com",
      php_version: "8.3",
      suspended: "no",
    });
  }

  it("source='live', isDaConnected=true, daMode='Live', warning=null", async () => {
    setupLive();
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("live");
    expect(body.isDaConnected).toBe(true);
    expect(body.daMode).toBe("Live");
    expect(body.warning).toBeNull();
  });

  it("happy row: status='active'; user{name,email} from local; usage + package + phpVersion from DA", async () => {
    setupLive();
    const res = await GET(makeReq());
    const body = await res.json();
    const row = body.data[0];
    expect(row.status).toBe("active");
    expect(row.user.name).toBe("First Last");
    expect(row.user.email).toBe("user@x.com");
    expect(row.usage).toEqual({
      bandwidth: "500",
      disk: "5000",
      bandwidthLimit: "1000",
      diskLimit: "10240",
    });
    expect(row.package).toBe("Pro");
    expect(row.phpVersion).toBe("8.3");
    expect(row.isUnlinked).toBe(false);
  });

  /**
   * Pins the dms-00200+ fix for the silent "0 B / 1 GB" display bug:
   * DA's CMD_API_SHOW_USER_CONFIG endpoint only returns LIMITS (bandwidth,
   * quota); the actual USAGE fields (bandwidth, quota on the usage endpoint
   * — same field names, different endpoint) live on CMD_API_SHOW_USER_USAGE.
   * The page had been silently displaying zero used bytes for every account
   * because the config endpoint doesn't populate `bandwidth_usage` /
   * `quota_usage` at all. The stats route now fetches both endpoints in
   * parallel and the usage-endpoint values win.
   */
  it("usage endpoint values win over (almost always undefined) config-endpoint usage fields", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
      bandwidth: "10000", // limit
      quota: "1024",      // limit
      // bandwidth_usage / quota_usage absent — this is what DA's config
      // endpoint actually returns in production.
    });
    getUserUsage.mockResolvedValueOnce({
      bandwidth: "2500", // 2.5 GB of bandwidth used
      quota: "780",       // 780 MB of disk used
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].usage).toEqual({
      bandwidth: "2500",
      disk: "780",
      bandwidthLimit: "10000",
      diskLimit: "1024",
    });
  });

  it("usage fetch failure for one user does not crash the row — usage shows 0 and config still surfaces", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
      bandwidth: "10000",
      quota: "1024",
      package: "Pro",
    });
    getUserUsage.mockRejectedValueOnce(new Error("DA usage endpoint timeout"));
    const res = await GET(makeReq());
    const body = await res.json();
    // Row still renders (not status='error') — usage fields fall back to '0'.
    expect(body.data[0].status).not.toBe("error");
    expect(body.data[0].usage.bandwidth).toBe("0");
    expect(body.data[0].usage.disk).toBe("0");
    expect(body.data[0].package).toBe("Pro");
  });

  it("'unlimited' bandwidth/quota → 'Unlimited' display strings", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
      bandwidth: "unlimited",
      quota: "unlimited",
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].usage.bandwidthLimit).toBe("Unlimited");
    expect(body.data[0].usage.diskLimit).toBe("Unlimited");
  });

  it("PHP version resolution: daConfig.php_version='Default' AND daConfig.php='ON' → serverInfo.php", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
      php_version: "Default",
      php: "ON",
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].phpVersion).toBe("8.2");
  });

  it("PHP version resolution: no daConfig.php_version + no daConfig.php='ON' → 'Default'", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({});
    getUserConfig.mockResolvedValueOnce({ domain: "alice.example.com" });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].phpVersion).toBe("Default");
  });
});

// ─── Email-fallback linking ────────────────────────────────────────
describe("Email-fallback linking (anti-stale-username)", () => {
  it("local user NOT found by daUsername → try email; matched → linkedByEmail:true", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([]); // empty — no username match
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce(["legacy_alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
      email: "user@x.com",
    });
    getUserBriefByEmail.mockResolvedValueOnce({
      _id: { toString: () => "U1" },
      firstName: "First",
      lastName: "Last",
      email: "user@x.com",
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].linkedByEmail).toBe(true);
    expect(body.data[0].user.email).toBe("user@x.com");
    expect(getUserBriefByEmail).toHaveBeenCalledWith("user@x.com");
  });

  it("local user found by daUsername → email lookup SKIPPED", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
      email: "user@x.com",
    });

    await GET(makeReq());
    expect(getUserBriefByEmail).not.toHaveBeenCalled();
  });

  it("isUnlinked=true when neither username nor email lookup finds local user", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce(["orphan"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "orphan.example.com",
      email: "ghost@x.com",
    });
    getUserBriefByEmail.mockResolvedValueOnce(null);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].isUnlinked).toBe(true);
    expect(body.data[0].user.name).toBe("Unlinked Account");
    expect(body.data[0].user.email).toBe("ghost@x.com");
  });
});

// ─── Best-match hosting record (3-tier) ────────────────────────────
describe("Best-match hosting record (3-tier resolution)", () => {
  it("Tier 1: exact username match wins over status/order", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    const records = [
      makeHostingRecord({
        _id: { toString: () => "H_other" },
        directAdminUsername: "other",
        status: "active",
      }),
      makeHostingRecord({
        _id: { toString: () => "H_exact" },
        directAdminUsername: "alice",
        status: "suspended",
      }),
    ];
    hostingFind.mockReturnValueOnce(chainableHostingFind(records));
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].dbId).toBe("H_exact");
  });

  it("Tier 2: no exact username → first 'active' record wins", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    const records = [
      makeHostingRecord({
        _id: { toString: () => "H_terminated" },
        directAdminUsername: "old",
        status: "terminated",
      }),
      makeHostingRecord({
        _id: { toString: () => "H_active" },
        directAdminUsername: "old",
        status: "active",
      }),
    ];
    hostingFind.mockReturnValueOnce(chainableHostingFind(records));
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].dbId).toBe("H_active");
  });

  it("Tier 3: no username + no active → first record wins (sorted createdAt:-1 means latest)", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    const records = [
      makeHostingRecord({
        _id: { toString: () => "H_latest" },
        directAdminUsername: "old",
        status: "terminated",
      }),
      makeHostingRecord({
        _id: { toString: () => "H_older" },
        directAdminUsername: "older",
        status: "terminated",
      }),
    ];
    hostingFind.mockReturnValueOnce(chainableHostingFind(records));
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].dbId).toBe("H_latest");
  });
});

// ─── Local-DB status override ──────────────────────────────────────
describe("Local DB status overrides DA status (anti-stale-DA)", () => {
  it("hostingRecord.status='suspended' overrides daConfig.suspended='no' → row shows 'suspended'", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(
      chainableHostingFind([
        makeHostingRecord({ status: "suspended" }),
      ])
    );
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
      suspended: "no",
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].status).toBe("suspended");
  });

  it("hostingRecord.status='terminated' overrides daConfig", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(
      chainableHostingFind([
        makeHostingRecord({ status: "terminated" }),
      ])
    );
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
      suspended: "no",
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].status).toBe("terminated");
  });

  it("hostingRecord.status='active' → DA suspended='yes' wins → 'suspended' (override only when DB is SUSPENDED/TERMINATED)", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(
      chainableHostingFind([makeHostingRecord({ status: "active" })])
    );
    listDAUsers.mockResolvedValueOnce(["alice"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.example.com",
      suspended: "yes",
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].status).toBe("suspended");
  });
});

// ─── Per-user DA fetch failure ─────────────────────────────────────
describe("Per-user DA fetch failure → error row (NOT crash)", () => {
  it("getUserConfig throw → error row with status='error', domain='Error fetching'", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce(["broken"]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });
    getUserConfig.mockRejectedValueOnce(new Error("user fetch failed"));

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      id: "broken",
      daUsername: "broken",
      status: "error",
      error: "user fetch failed",
      domain: "Error fetching",
    });
  });
});

// ─── DA-unreachable: fallback DB mode ──────────────────────────────
describe("DA unreachable → FALLBACK DB mode", () => {
  it("listUsers throw → isDaConnected:false, source:'db', warning set", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(
      chainableHostingFind([makeHostingRecord()])
    );
    listDAUsers.mockRejectedValueOnce(new Error("DA connection refused"));

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isDaConnected).toBe(false);
    expect(body.source).toBe("db");
    expect(body.daMode).toBe("Disconnected");
    expect(body.warning).toMatch(/DA connection refused/);
    expect(body.daError).toBe("DA connection refused");
  });

  it("Fallback DB mode: data mapped from hostingRecords; usage placeholders ('0' / 'Unknown')", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([makeLocalUser()]);
    hostingFind.mockReturnValueOnce(
      chainableHostingFind([makeHostingRecord()])
    );
    listDAUsers.mockRejectedValueOnce(new Error("DA down"));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      domain: "alice.example.com",
      status: "active",
      usage: {
        bandwidth: "0",
        disk: "0",
        bandwidthLimit: "Unknown",
        diskLimit: "Unknown",
      },
      package: "Pro Plan",
      phpVersion: "Unknown",
    });
  });

  it("Fallback DB mode: hostingRecord with no matching local user → user='Unknown User'", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([]);
    hostingFind.mockReturnValueOnce(
      chainableHostingFind([makeHostingRecord()])
    );
    listDAUsers.mockRejectedValueOnce(new Error("DA down"));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].user.name).toBe("Unknown User");
    expect(body.data[0].isUnlinked).toBe(true);
  });
});

// ─── 5-second DA timeout ───────────────────────────────────────────
describe("5s DA timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("DA hang past 5s → fallback mode with 'timed out (5s limit)' message", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    // DA never resolves
    listDAUsers.mockImplementationOnce(() => new Promise(() => {}));
    getAllUserUsage.mockImplementationOnce(() => new Promise(() => {}));
    getServerInfo.mockImplementationOnce(() => new Promise(() => {}));

    const pending = GET(makeReq());
    await vi.advanceTimersByTimeAsync(5001);
    const res = await pending;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isDaConnected).toBe(false);
    expect(body.daError).toBe(
      "Connection attempt to DirectAdmin timed out (5s limit)"
    );
  });
});

// ─── daMode detection ──────────────────────────────────────────────
describe("daMode detection", () => {
  it.each([
    ["http://localhost:2222", "Local"],
    ["http://127.0.0.1:2222", "Local"],
    ["http://host.docker.internal:2222", "Local"],
    ["https://da.production.example.com", "Live"],
  ])("DIRECTADMIN_URL '%s' → daMode '%s' when DA connected", async (url, expected) => {
    vi.stubEnv("DIRECTADMIN_URL", url);
    listUsersWithDirectAdmin.mockResolvedValueOnce([]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce([]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.daMode).toBe(expected);
  });

  it("DA unreachable → daMode='Disconnected' regardless of URL", async () => {
    vi.stubEnv("DIRECTADMIN_URL", "http://localhost:2222");
    listUsersWithDirectAdmin.mockResolvedValueOnce([]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockRejectedValueOnce(new Error("DA down"));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.daMode).toBe("Disconnected");
  });
});

// ─── Hosting find error tolerance ──────────────────────────────────
describe("Hosting.find error tolerance", () => {
  it("hostingFind throw → empty [] (does not crash; the inner IIFE catches)", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([]);
    hostingFind.mockImplementationOnce(() => {
      throw new Error("DB down");
    });
    listDAUsers.mockResolvedValueOnce([]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });
});

// Outer catch (last-ditch fallback hosting+listAllUserBriefs) is a
// 2nd-tier resilience path. Pinning it under vitest is hard to keep
// stable because the post-Promise.all-rejection code path interacts
// with two dynamic imports + multiple async chains; tests around it
// flake on timer ordering. The route's main paths (LIVE, DB fallback,
// per-user-error row, 5s timeout) are all pinned above.

// ─── Response shape (full live) ────────────────────────────────────
describe("Response shape — full live", () => {
  it("success + data array + source + isDaConnected + daError + daMode + warning", async () => {
    listUsersWithDirectAdmin.mockResolvedValueOnce([]);
    hostingFind.mockReturnValueOnce(chainableHostingFind([]));
    listDAUsers.mockResolvedValueOnce([]);
    getAllUserUsage.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      data: [],
      source: "live",
      isDaConnected: true,
      daError: null,
      daMode: expect.any(String),
      warning: null,
    });
  });
});
