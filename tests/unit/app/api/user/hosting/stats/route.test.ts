/**
 * Tests for `app/api/user/hosting/stats/route.ts` (slice 7gc).
 * Customer-facing mirror of admin slice 7g6. Returns an ARRAY of
 * hosting accounts owned by the authenticated user (primary +
 * email-matched secondary).
 *
 * Pins:
 *  - **Auth gate FIRST** (no user → 401 UNAUTHORIZED via
 *    secureErrorResponse)
 *  - **Per-user rate-limit** keyed `stats:${user._id}` against the
 *    `api` limiter (NOT a global IP cap) — bounds DA fan-out per
 *    user; over-limit → rateLimitResponse with limit:100 + 'Too
 *    many stats requests' message; NO downstream calls
 *  - **Fast path** when user.directAdminUsername is set: skip the
 *    full DA enumeration; only that one username is in the target set
 *  - **Slow fallback path**: ONLY when no linked username AND user
 *    has an email — calls listUsers + per-user getUserConfig email
 *    comparison
 *  - **Anti-OOM cap**: if listUsers returns > 200 entries, the scan
 *    is SKIPPED with a warn (the fan-out otherwise = N RPC calls)
 *  - **Email-scan per-user error swallowed** — one failing
 *    getUserConfig must not kill the whole scan (best-effort)
 *  - **Empty target set** (no linked + no email + empty discovery)
 *    returns success:true data:[] without further DA work
 *  - **Per-account fetch failure** swallowed → returns null and is
 *    filtered out of the array (matches the admin route's behavior:
 *    one broken account must not blank the whole page)
 *  - **Status normalisation contract** (UI shows 3 terms only:
 *    Active / Pending / Suspended):
 *      - suspended==='yes' from DA → 'suspended'
 *      - active + past-expiry → 'suspended' (billing override)
 *      - local DB 'suspended'/'terminated' wins over DA 'active'
 *        ONLY when hostingRecord.directAdminUsername matches
 *      - anything else non-active/non-pending → 'suspended'
 *  - **Hosting record 3-tier match**: (1) exact daUsername (2)
 *    status:'active' (3) fallback to first
 *  - **Nameservers**: default to DirectAdminService.NAMESERVERS;
 *    when getDNSRecords returns NS records distinct from the
 *    domain, those replace the default (deduped). getDNSRecords
 *    throw → swallowed, defaults kept
 *  - **PHP version resolution chain**: php_version → php1_select
 *    → serverInfo.php (when php==='ON') → 'Default'
 *  - **'unlimited' → 'Unlimited'** display string (case-insensitive)
 *  - **upsertHostingFromDirectAdminStats throw SWALLOWED** — DB
 *    write failure must not blank the user's stats page
 *  - **HostingPlan lookup throw SWALLOWED** — planDetails null,
 *    keep going
 *  - **Error mapping** (outer catch):
 *      - status:503 / code:DA_SERVER_DOWN / ECONNREFUSED /
 *        ETIMEDOUT / 'status code 503' / 'status code 502' → 503
 *        DA_SERVER_DOWN
 *      - anything else → 500 STATS_FETCH_FAILED
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const checkKey = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { api: { checkKey } },
  rateLimitResponse,
}));

const getAllUserUsage = vi.hoisted(() => vi.fn());
const getServerInfo = vi.hoisted(() => vi.fn());
const getUserConfig = vi.hoisted(() => vi.fn());
const getUserUsage = vi.hoisted(() => vi.fn());
const listUsers = vi.hoisted(() => vi.fn());
const getDNSRecords = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: {
    getAllUserUsage,
    getServerInfo,
    getUserConfig,
    getUserUsage,
    listUsers,
    getDNSRecords,
    NAMESERVERS: ["ns1.default.com", "ns2.default.com"],
  },
}));

const listUserHostingsByDomain = vi.hoisted(() => vi.fn());
const upsertHostingFromDirectAdminStats = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({
  listUserHostingsByDomain,
  upsertHostingFromDirectAdminStats,
}));

const planFindOne = vi.hoisted(() => vi.fn());
vi.mock("@/models/HostingPlan", () => ({
  default: { findOne: planFindOne },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/user/hosting/stats/route";

function makeReq() {
  return new NextRequest("https://example.com/api/user/hosting/stats", {
    method: "GET",
  });
}

const user = {
  _id: "U1",
  email: "alice@example.com",
  directAdminUsername: "alice_da",
};

function freshDaConfig(overrides: Record<string, unknown> = {}) {
  return {
    domain: "alice.com",
    bandwidth: "1000",
    quota: "5000",
    ip: "1.2.3.4",
    suspended: "no",
    package: "starter",
    php_version: "8.2",
    php: "ON",
    ssl: "ON",
    cgi: "OFF",
    spam: "ON",
    mysql: "10",
    nemails: "20",
    ftp: "5",
    nsubdomains: "10",
    email: "alice@example.com",
    date_created: "2026-01-01",
    ...overrides,
  };
}

function freshDaUsage(overrides: Record<string, unknown> = {}) {
  return {
    bandwidth: "500",
    quota: "2500",
    nmysql: "3",
    nemails: "8",
    nftp: "2",
    nsubdomains: "1",
    ...overrides,
  };
}

// Planning chain for the "happy path" — sets up all required mocks
function happyDA() {
  getAllUserUsage.mockResolvedValue({ alice_da: { bandwidth: "500" } });
  getServerInfo.mockResolvedValue({ php: "8.2" });
  getUserConfig.mockResolvedValue(freshDaConfig());
  getUserUsage.mockResolvedValue(freshDaUsage());
  getDNSRecords.mockResolvedValue([]);
  listUserHostingsByDomain.mockResolvedValue([]);
  planFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
  upsertHostingFromDirectAdminStats.mockResolvedValue(undefined);
}

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  checkKey.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
  getAllUserUsage.mockReset();
  getServerInfo.mockReset();
  getUserConfig.mockReset();
  getUserUsage.mockReset();
  listUsers.mockReset();
  getDNSRecords.mockReset();
  listUserHostingsByDomain.mockReset();
  upsertHostingFromDirectAdminStats.mockReset();
  planFindOne.mockReset();
});

// ─── Auth + rate-limit ─────────────────────────────────────────────
describe("Auth gate", () => {
  it("no user → 401 UNAUTHORIZED; NO rate-limit call", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(checkKey).not.toHaveBeenCalled();
  });
});

describe("Rate limit (per-user, NOT IP)", () => {
  it("checkKey called with `stats:${user._id}` — per-user cap", async () => {
    happyDA();
    await GET(makeReq());
    expect(checkKey).toHaveBeenCalledWith("stats:U1");
  });

  it("over limit → rateLimitResponse with limit:100; NO DA calls", async () => {
    checkKey.mockResolvedValueOnce({ allowed: false });
    const rlRes = new Response("rate-limited", { status: 429 });
    rateLimitResponse.mockReturnValueOnce(rlRes);

    const res = await GET(makeReq());
    expect(res).toBe(rlRes);
    expect(rateLimitResponse).toHaveBeenCalledWith(
      { allowed: false },
      {
        limit: 100,
        message: "Too many stats requests. Please wait before retrying.",
      }
    );
    expect(getAllUserUsage).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
  });
});

// ─── Fast path: linked DA username ────────────────────────────────
describe("Fast path — user.directAdminUsername set", () => {
  it("skips email-discovery scan entirely; only linked username is targeted", async () => {
    happyDA();
    await GET(makeReq());
    expect(listUsers).not.toHaveBeenCalled();
    // Only one getUserConfig call (for the single linked daUsername)
    expect(getUserConfig).toHaveBeenCalledTimes(1);
    expect(getUserConfig).toHaveBeenCalledWith("alice_da");
  });
});

// ─── Slow fallback: email-discovery scan ───────────────────────────
describe("Email-discovery fallback (no linked username)", () => {
  it("scans DA users + matches by email when user.directAdminUsername is missing", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      ...user,
      directAdminUsername: undefined,
    });
    getAllUserUsage.mockResolvedValue({});
    getServerInfo.mockResolvedValue({ php: "8.2" });
    listUsers.mockResolvedValueOnce(["bob_da", "alice_da", "carol_da"]);
    getUserConfig.mockImplementation((u) =>
      Promise.resolve(
        u === "alice_da"
          ? freshDaConfig({ email: "alice@example.com" })
          : freshDaConfig({ email: "someone-else@example.com" })
      )
    );
    getUserUsage.mockResolvedValue(freshDaUsage());
    getDNSRecords.mockResolvedValue([]);
    listUserHostingsByDomain.mockResolvedValue([]);
    planFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    upsertHostingFromDirectAdminStats.mockResolvedValue(undefined);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].username).toBe("alice_da");
  });

  it("skips email scan if user has no email AND no linked username → returns empty data", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U2",
      email: undefined,
      directAdminUsername: undefined,
    });
    getAllUserUsage.mockResolvedValue({});
    getServerInfo.mockResolvedValue({ php: "8.2" });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(listUsers).not.toHaveBeenCalled();
  });

  it("DA user list > MAX_SCAN (200) → SKIPS scan (anti-fan-out), returns empty data", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      ...user,
      directAdminUsername: undefined,
    });
    getAllUserUsage.mockResolvedValue({});
    getServerInfo.mockResolvedValue({ php: "8.2" });
    listUsers.mockResolvedValueOnce(
      Array.from({ length: 201 }, (_, i) => `u${i}`)
    );

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    // Crucially — getUserConfig must NOT be called 201 times
    expect(getUserConfig).not.toHaveBeenCalled();
  });

  it("per-user getUserConfig error in scan → swallowed, scan continues", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      ...user,
      directAdminUsername: undefined,
    });
    getAllUserUsage.mockResolvedValue({});
    getServerInfo.mockResolvedValue({ php: "8.2" });
    listUsers.mockResolvedValueOnce(["broken", "alice_da"]);
    getUserConfig.mockImplementation((u) => {
      if (u === "broken") return Promise.reject(new Error("DA blip"));
      if (u === "alice_da")
        return Promise.resolve(freshDaConfig({ email: "alice@example.com" }));
      return Promise.resolve(freshDaConfig());
    });
    getUserUsage.mockResolvedValue(freshDaUsage());
    getDNSRecords.mockResolvedValue([]);
    listUserHostingsByDomain.mockResolvedValue([]);
    planFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    upsertHostingFromDirectAdminStats.mockResolvedValue(undefined);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].username).toBe("alice_da");
  });
});

// ─── Per-account failure isolation ─────────────────────────────────
describe("Per-account fetch failure", () => {
  it("getUserConfig throw on detail fetch → that account dropped (null filtered); others survive", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      ...user,
      directAdminUsername: undefined,
    });
    getAllUserUsage.mockResolvedValue({});
    getServerInfo.mockResolvedValue({ php: "8.2" });
    listUsers.mockResolvedValueOnce(["alice_da", "alice_secondary"]);
    // Discovery phase: both match by email
    let calls = 0;
    getUserConfig.mockImplementation((u) => {
      calls++;
      // First two calls = discovery; both match
      if (calls <= 2) {
        return Promise.resolve(freshDaConfig({ email: "alice@example.com" }));
      }
      // Subsequent calls = detail fetch
      if (u === "alice_da") {
        return Promise.resolve(freshDaConfig());
      }
      return Promise.reject(new Error("detail fetch broke"));
    });
    getUserUsage.mockResolvedValue(freshDaUsage());
    getDNSRecords.mockResolvedValue([]);
    listUserHostingsByDomain.mockResolvedValue([]);
    planFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    upsertHostingFromDirectAdminStats.mockResolvedValue(undefined);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });
});

// ─── Status normalisation ─────────────────────────────────────────
describe("Status normalisation (3-term UI contract)", () => {
  it("DA suspended=yes → status:'suspended'", async () => {
    happyDA();
    getUserConfig.mockResolvedValue(freshDaConfig({ suspended: "yes" }));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].status).toBe("suspended");
  });

  it("active + past-expiry → billing override to 'suspended'", async () => {
    happyDA();
    const pastDate = new Date("2020-01-01");
    listUserHostingsByDomain.mockResolvedValue([
      {
        _id: "H1",
        directAdminUsername: "alice_da",
        status: "active",
        expiryDate: pastDate,
        startDate: new Date("2019-01-01"),
        autoRenew: false,
        billingType: "manual",
        isTrial: false,
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].status).toBe("suspended");
  });

  it("local 'terminated' wins over DA 'active' ONLY when hosting.daUsername matches", async () => {
    happyDA();
    listUserHostingsByDomain.mockResolvedValue([
      {
        _id: "H1",
        directAdminUsername: "alice_da", // matches
        status: "terminated",
        expiryDate: new Date("2099-01-01"),
        startDate: new Date("2026-01-01"),
        autoRenew: false,
        billingType: "manual",
        isTrial: false,
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    // 'terminated' → coerced to 'suspended' via the final fallthrough
    expect(body.data[0].status).toBe("suspended");
  });

  it("local 'terminated' but daUsername does NOT match → DA 'active' wins", async () => {
    happyDA();
    listUserHostingsByDomain.mockResolvedValue([
      {
        _id: "H1",
        directAdminUsername: "different_da_user", // does NOT match
        status: "terminated",
        expiryDate: new Date("2099-01-01"),
        startDate: new Date("2026-01-01"),
        autoRenew: false,
        billingType: "manual",
        isTrial: false,
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    // Stays active because override-by-mismatch guard prevents the local
    // status from leaking onto a different DA account
    expect(body.data[0].status).toBe("active");
  });
});

// ─── 3-tier hosting-record match ──────────────────────────────────
describe("3-tier hosting-record selection", () => {
  it("tier 1: exact daUsername match wins over later active record", async () => {
    happyDA();
    listUserHostingsByDomain.mockResolvedValue([
      {
        _id: "H_OTHER",
        directAdminUsername: "other_da",
        status: "active",
        expiryDate: new Date("2099-01-01"),
        startDate: new Date("2026-01-01"),
      },
      {
        _id: "H_MATCH",
        directAdminUsername: "alice_da",
        status: "suspended",
        expiryDate: new Date("2099-01-01"),
        startDate: new Date("2026-01-01"),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].hostingId).toBe("H_MATCH");
  });

  it("tier 2: status:active wins when no exact daUsername match", async () => {
    happyDA();
    listUserHostingsByDomain.mockResolvedValue([
      {
        _id: "H_PENDING",
        directAdminUsername: "other_da",
        status: "pending",
        expiryDate: new Date("2099-01-01"),
        startDate: new Date("2026-01-01"),
      },
      {
        _id: "H_ACTIVE",
        directAdminUsername: "yet_another",
        status: "active",
        expiryDate: new Date("2099-01-01"),
        startDate: new Date("2026-01-01"),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].hostingId).toBe("H_ACTIVE");
  });

  it("tier 3: first record when no match + no active", async () => {
    happyDA();
    listUserHostingsByDomain.mockResolvedValue([
      {
        _id: "H_FIRST",
        directAdminUsername: "other_da",
        status: "pending",
        expiryDate: new Date("2099-01-01"),
        startDate: new Date("2026-01-01"),
      },
      {
        _id: "H_SECOND",
        directAdminUsername: "yet_another",
        status: "pending",
        expiryDate: new Date("2099-01-01"),
        startDate: new Date("2026-01-01"),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].hostingId).toBe("H_FIRST");
  });
});

// ─── Nameservers + PHP resolution + Unlimited string ──────────────
describe("Nameservers", () => {
  it("getDNSRecords returns NS records → replaces default NAMESERVERS (deduped)", async () => {
    happyDA();
    getDNSRecords.mockResolvedValueOnce([
      { type: "NS", value: "ns1.custom.com." },
      { type: "NS", value: "ns2.custom.com." },
      { type: "NS", value: "ns1.custom.com." }, // dup
      { type: "A", value: "1.2.3.4" }, // not NS, filtered
      { type: "NS", value: "alice.com." }, // self, filtered
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].nameservers).toEqual([
      "ns1.custom.com",
      "ns2.custom.com",
    ]);
  });

  it("getDNSRecords throw → swallowed, default NAMESERVERS used", async () => {
    happyDA();
    getDNSRecords.mockRejectedValueOnce(new Error("DNS read failed"));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].nameservers).toEqual([
      "ns1.default.com",
      "ns2.default.com",
    ]);
  });
});

describe("PHP version resolution chain", () => {
  it("daConfig.php_version (non-Default) wins", async () => {
    happyDA();
    getUserConfig.mockResolvedValue(freshDaConfig({ php_version: "8.3" }));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].php).toBe("8.3");
  });

  it("php_version 'Default' but php1_select present → use php1_select", async () => {
    happyDA();
    getUserConfig.mockResolvedValue(
      freshDaConfig({ php_version: "Default", php1_select: "7.4" })
    );
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].php).toBe("7.4");
  });

  it("no php_version + no php1_select + php=ON + serverInfo.php → use serverInfo.php", async () => {
    happyDA();
    getServerInfo.mockResolvedValue({ php: "8.1" });
    getUserConfig.mockResolvedValue(
      freshDaConfig({ php_version: undefined, php1_select: undefined, php: "ON" })
    );
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].php).toBe("8.1");
  });

  it("no info → 'Default' fallback", async () => {
    happyDA();
    getServerInfo.mockResolvedValue({});
    getUserConfig.mockResolvedValue(
      freshDaConfig({ php_version: undefined, php1_select: undefined, php: "OFF" })
    );
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].php).toBe("Default");
  });
});

describe("'unlimited' → 'Unlimited' display string", () => {
  it("case-insensitive match coerces to 'Unlimited'", async () => {
    happyDA();
    getUserConfig.mockResolvedValue(
      freshDaConfig({ bandwidth: "UNLIMITED", quota: "unlimited", mysql: "Unlimited" })
    );
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].usage.bandwidth_limit).toBe("Unlimited");
    expect(body.data[0].usage.disk_limit).toBe("Unlimited");
    expect(body.data[0].usage.databases.limit).toBe("Unlimited");
  });
});

// ─── DB sync failure swallowed ─────────────────────────────────────
describe("DB sync failure isolation", () => {
  it("upsertHostingFromDirectAdminStats throw → swallowed, stats still returned", async () => {
    happyDA();
    upsertHostingFromDirectAdminStats.mockRejectedValueOnce(
      new Error("Mongo write failed")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].domain).toBe("alice.com");
  });

  it("HostingPlan.findOne throw → swallowed, planDetails:null", async () => {
    happyDA();
    planFindOne.mockImplementationOnce(() => {
      throw new Error("HostingPlan import failed");
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].planDetails).toBeNull();
  });
});

// ─── Outer error mapping (DA-down → 503) ──────────────────────────
describe("Error mapping (outer catch)", () => {
  it("error.status === 503 → 503 DA_SERVER_DOWN", async () => {
    const err = Object.assign(new Error("Service blew up"), { status: 503 });
    getServerInfo.mockRejectedValueOnce(err);
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("DA_SERVER_DOWN");
  });

  it("error.code === DA_SERVER_DOWN → 503", async () => {
    const err = Object.assign(new Error("DA gone"), { code: "DA_SERVER_DOWN" });
    getServerInfo.mockRejectedValueOnce(err);
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
  });

  it("error.code === ECONNREFUSED → 503", async () => {
    const err = Object.assign(new Error("connect refused"), {
      code: "ECONNREFUSED",
    });
    getServerInfo.mockRejectedValueOnce(err);
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
  });

  it("error.code === ETIMEDOUT → 503", async () => {
    const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    getServerInfo.mockRejectedValueOnce(err);
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
  });

  it("message contains 'status code 503' → 503", async () => {
    getServerInfo.mockRejectedValueOnce(
      new Error("Request failed with status code 503")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
  });

  it("message contains 'status code 502' → 503", async () => {
    getServerInfo.mockRejectedValueOnce(
      new Error("Bad Gateway: status code 502")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
  });

  it("generic error → 500 STATS_FETCH_FAILED", async () => {
    getServerInfo.mockRejectedValueOnce(new Error("Unexpected"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("STATS_FETCH_FAILED");
  });
});

// ─── isPrimary flag ───────────────────────────────────────────────
describe("isPrimary flag", () => {
  it("true when daUsername === user.directAdminUsername", async () => {
    happyDA();
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].isPrimary).toBe(true);
  });

  it("false for email-discovered secondary accounts", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      ...user,
      directAdminUsername: undefined,
    });
    getAllUserUsage.mockResolvedValue({});
    getServerInfo.mockResolvedValue({ php: "8.2" });
    listUsers.mockResolvedValueOnce(["secondary_da"]);
    getUserConfig.mockResolvedValue(
      freshDaConfig({ email: "alice@example.com" })
    );
    getUserUsage.mockResolvedValue(freshDaUsage());
    getDNSRecords.mockResolvedValue([]);
    listUserHostingsByDomain.mockResolvedValue([]);
    planFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    upsertHostingFromDirectAdminStats.mockResolvedValue(undefined);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].isPrimary).toBe(false);
  });
});

// ─── mandateMode discriminator (customer dashboard payment-validity note) ─
//
// The customer dashboard at app/dashboard/hosting/page.tsx renders an
// amber "Keep your payment method valid" note ONLY when mandateMode is
// 'tokens'. The discriminator is derived server-side here from
// hostingRecord.razorpayTokenId / .subscriptionId so the customer page
// doesn't need to inspect billing internals directly. Anti-misinform
// rule: Subscriptions-flow customers (Razorpay handles retries
// server-side) and manual customers (no auto-renewal) must NOT receive
// this discriminator value, since the note's strict-suspension language
// doesn't apply to them.
describe("mandateMode discriminator (drives customer payment-validity note)", () => {
  it("razorpayTokenId set → mandateMode='tokens' (Tokens-flow customer; triggers dashboard note)", async () => {
    happyDA();
    listUserHostingsByDomain.mockResolvedValueOnce([
      {
        _id: { toString: () => "H_tokens" },
        directAdminUsername: "alice_da",
        razorpayTokenId: "token_TOK1",
        razorpayCustomerId: "cust_TOK1",
        subscriptionId: null,
        isTrial: false,
        billingType: "subscription",
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].mandateMode).toBe("tokens");
  });

  it("subscriptionId set (no razorpayTokenId) → mandateMode='subscriptions' (Subscriptions-flow customer; no note)", async () => {
    happyDA();
    listUserHostingsByDomain.mockResolvedValueOnce([
      {
        _id: { toString: () => "H_sub" },
        directAdminUsername: "alice_da",
        subscriptionId: "sub_LIVE123",
        razorpayTokenId: null,
        razorpayCustomerId: null,
        isTrial: false,
        billingType: "subscription",
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].mandateMode).toBe("subscriptions");
  });

  it("neither razorpayTokenId nor subscriptionId → mandateMode='manual' (no auto-renewal; no note)", async () => {
    happyDA();
    listUserHostingsByDomain.mockResolvedValueOnce([
      {
        _id: { toString: () => "H_manual" },
        directAdminUsername: "alice_da",
        subscriptionId: null,
        razorpayTokenId: null,
        razorpayCustomerId: null,
        isTrial: false,
        billingType: "manual",
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].mandateMode).toBe("manual");
  });

  it("BOTH razorpayTokenId AND subscriptionId set → mandateMode='tokens' (Tokens-flow wins; migrating customer)", async () => {
    // Realistic edge case: a customer who started on Subscriptions and
    // was later migrated to Tokens-flow would briefly have both IDs on
    // the record. The hard 1-attempt MIT policy applies because the
    // active mandate is the Token; the orphaned subscriptionId is a
    // historical reference. Tokens MUST win the discriminator.
    happyDA();
    listUserHostingsByDomain.mockResolvedValueOnce([
      {
        _id: { toString: () => "H_migrated" },
        directAdminUsername: "alice_da",
        subscriptionId: "sub_OLD",
        razorpayTokenId: "token_NEW",
        razorpayCustomerId: "cust_NEW",
        isTrial: false,
        billingType: "subscription",
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].mandateMode).toBe("tokens");
  });

  it("no matching hosting record at all → mandateMode='manual' (defensive default)", async () => {
    happyDA();
    listUserHostingsByDomain.mockResolvedValueOnce([]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data[0].mandateMode).toBe("manual");
  });
});
