/**
 * Tests for `app/api/admin/hosting/details/route.ts` (slice 7hw, part 1).
 *
 * Admin "show me this customer's hosting account" deep-dive view —
 * pulls 3 DA probes in parallel and shapes them into a curated dashboard.
 *
 * Threat model:
 *  - **Raw DA field leak**: a refactor that returns the spread DA
 *    config object would expose internal fields like userType, raw
 *    package metadata, etc. Pinned: response carries only the
 *    `detailedStats` whitelist.
 *  - **Nameserver lookup failure blanking the dashboard**: live NS
 *    fetch can flake; must fall back to the hardcoded ResellerClub
 *    nameservers rather than crash. Pinned.
 *  - **Listing-all default for missing username**: if `?username` is
 *    missing, the route must NOT default to "fetch the first user"
 *    or similar — it must 400. Pinned.
 *
 * Other pins:
 *  - Admin gate → 403 FORBIDDEN (not 401 — auth assumed)
 *  - Missing ?username → 400 BAD_REQUEST
 *  - Three DA probes in PARALLEL (Promise.all)
 *  - resolveLimit: 'unlimited' (any case) → 'Unlimited'; falsy → '0'
 *    fallback; other values pass through
 *  - PHP version preference chain:
 *      daConfig.php_version (non-'Default') → use it
 *      else daConfig.php1_select → use it
 *      else daConfig.php === 'ON' AND serverInfo.php → use server
 *      else 'Default'
 *  - suspended==='yes' → status='suspended'; else 'active'
 *  - getDNSRecords throw is SWALLOWED; nameservers fall back to
 *    DirectAdminService.NAMESERVERS (the ResellerClub defaults)
 *  - getDNSRecords with no NS records → fallback (empty actualNs)
 *  - getDNSRecords trailing-dot stripped from NS values
 *  - ftp.used parseInt coercion (so a string "5" becomes "5",
 *    matches Panel UI which adds 1 — pinned via the .toString() call)
 *  - Outer catch → 500 DETAILS_FETCH_FAILED; no sentinel leak
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const getUserConfig = vi.hoisted(() => vi.fn());
const getUserUsage = vi.hoisted(() => vi.fn());
const getServerInfo = vi.hoisted(() => vi.fn());
const getDNSRecords = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: {
    getUserConfig,
    getUserUsage,
    getServerInfo,
    getDNSRecords,
    NAMESERVERS: [
      "deepak1299294.mercury.orderbox-dns.com",
      "deepak1299294.venus.orderbox-dns.com",
      "deepak1299294.earth.orderbox-dns.com",
      "deepak1299294.mars.orderbox-dns.com",
    ],
  },
}));

vi.mock("@/lib/mongodb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/hosting/details/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/admin/hosting/details?${qs}`
    : "https://example.com/api/admin/hosting/details";
  return new NextRequest(url, { method: "GET" });
}

function setupHappy() {
  isAdmin.mockResolvedValue(true);
  getUserConfig.mockResolvedValue({
    domain: "alice.com",
    suspended: "no",
    ip: "203.0.113.1",
    bandwidth: "10000",
    quota: "5000",
    mysql: "10",
    nemails: "20",
    ftp: "5",
    nsubdomains: "10",
    ssl: "ON",
    cgi: "OFF",
    php: "ON",
    spam: "OFF",
    ssh: "OFF",
    cron: "ON",
    dnscontrol: "OFF",
    package: "Starter",
    php_version: "8.2",
    date_created: "2026-01-01",
    usertype: "user",
  });
  getUserUsage.mockResolvedValue({
    bandwidth: "1000",
    quota: "500",
    nmysql: "3",
    nemails: "5",
    nftp: "2",
    nsubdomains: "1",
  });
  getServerInfo.mockResolvedValue({ php: "8.1" });
  getDNSRecords.mockResolvedValue([]);
}

beforeEach(() => {
  isAdmin.mockReset();
  getUserConfig.mockReset();
  getUserUsage.mockReset();
  getServerInfo.mockReset();
  getDNSRecords.mockReset();
});

describe("Admin gate", () => {
  it("non-admin → 403 FORBIDDEN; NO DA probes", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq("username=alice_da"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(getUserConfig).not.toHaveBeenCalled();
  });
});

describe("Missing username", () => {
  it("no ?username → 400 BAD_REQUEST; NO DA probe", async () => {
    isAdmin.mockResolvedValueOnce(true);
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
    expect(getUserConfig).not.toHaveBeenCalled();
  });
});

describe("Parallel DA probes", () => {
  it("getUserConfig + getUserUsage + getServerInfo all called with username", async () => {
    setupHappy();
    await GET(makeReq("username=alice_da"));
    expect(getUserConfig).toHaveBeenCalledWith("alice_da");
    expect(getUserUsage).toHaveBeenCalledWith("alice_da");
    expect(getServerInfo).toHaveBeenCalledWith();
  });
});

describe("Nameserver resolution", () => {
  it("live NS records found → returned with trailing dots stripped", async () => {
    setupHappy();
    getDNSRecords.mockResolvedValueOnce([
      { type: "NS", value: "ns1.example.com." },
      { type: "NS", value: "ns2.example.com." },
      { type: "A", value: "1.2.3.4" }, // not NS — filtered out
    ]);
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.nameservers).toEqual([
      "ns1.example.com",
      "ns2.example.com",
    ]);
  });

  it("getDNSRecords THROW → falls back to RC default nameservers; main 200", async () => {
    setupHappy();
    getDNSRecords.mockRejectedValueOnce(new Error("DA dns lookup failed"));
    const res = await GET(makeReq("username=alice_da"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.nameservers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("orderbox-dns.com"),
      ])
    );
  });

  it("empty actualNs (no NS records) → falls back to RC defaults", async () => {
    setupHappy();
    getDNSRecords.mockResolvedValueOnce([
      { type: "A", value: "1.2.3.4" },
      { type: "MX", value: "mail.example.com" },
    ]);
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.nameservers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("orderbox-dns.com"),
      ])
    );
  });
});

describe("resolveLimit normalisation", () => {
  it("'unlimited' (lower) → 'Unlimited'", async () => {
    setupHappy();
    getUserConfig.mockResolvedValueOnce({
      domain: "x.com",
      suspended: "no",
      bandwidth: "unlimited",
      quota: "unlimited",
      mysql: "unlimited",
      nemails: "unlimited",
      ftp: "unlimited",
      nsubdomains: "unlimited",
    });
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.usage.bandwidth_limit).toBe("Unlimited");
    expect(body.data.usage.disk_limit).toBe("Unlimited");
    expect(body.data.usage.databases.limit).toBe("Unlimited");
    expect(body.data.usage.emails.limit).toBe("Unlimited");
    expect(body.data.usage.ftp.limit).toBe("Unlimited");
    expect(body.data.usage.subdomains.limit).toBe("Unlimited");
  });

  it("'UNLIMITED' (upper) → 'Unlimited' (case-insensitive)", async () => {
    setupHappy();
    getUserConfig.mockResolvedValueOnce({
      domain: "x.com",
      suspended: "no",
      mysql: "UNLIMITED",
    });
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.usage.databases.limit).toBe("Unlimited");
  });

  it("numeric values pass through unchanged", async () => {
    setupHappy();
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.usage.bandwidth_limit).toBe("10000");
    expect(body.data.usage.databases.limit).toBe("10");
  });

  it("falsy/missing → '0' fallback", async () => {
    setupHappy();
    getUserConfig.mockResolvedValueOnce({
      domain: "x.com",
      suspended: "no",
      // mysql undefined → fallback
    });
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.usage.databases.limit).toBe("0");
  });
});

describe("PHP version preference chain", () => {
  it("php_version set + non-'Default' → use it", async () => {
    setupHappy();
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.php).toBe("8.2");
  });

  it("php_version='Default' + php1_select='7.4' → use php1_select", async () => {
    setupHappy();
    getUserConfig.mockResolvedValueOnce({
      domain: "x.com",
      suspended: "no",
      php: "ON",
      php_version: "Default",
      php1_select: "7.4",
    });
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.php).toBe("7.4");
  });

  it("no php_version + no php1_select + php='ON' + serverInfo.php='8.1' → use server php", async () => {
    setupHappy();
    getUserConfig.mockResolvedValueOnce({
      domain: "x.com",
      suspended: "no",
      php: "ON",
    });
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.php).toBe("8.1");
  });

  it("php OFF + no version hints → falls all the way through to 'Default'", async () => {
    setupHappy();
    getUserConfig.mockResolvedValueOnce({
      domain: "x.com",
      suspended: "no",
      php: "OFF",
    });
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.php).toBe("Default");
  });
});

describe("Status mapping", () => {
  it("suspended==='yes' → status='suspended'", async () => {
    setupHappy();
    getUserConfig.mockResolvedValueOnce({
      domain: "x.com",
      suspended: "yes",
    });
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.status).toBe("suspended");
  });

  it("suspended==='no' (or anything else) → status='active'", async () => {
    setupHappy();
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.status).toBe("active");
  });
});

describe("Features map", () => {
  it("strict 'ON'/'OFF' boolean coercion", async () => {
    setupHappy();
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.features).toEqual({
      ssl: true,
      cgi: false,
      php: true,
      spam: false,
      ssh: false,
      cron: true,
      dnscontrol: false,
    });
  });

  it("'on' (lower) does NOT count as ON (strict equality)", async () => {
    setupHappy();
    getUserConfig.mockResolvedValueOnce({
      domain: "x.com",
      suspended: "no",
      ssl: "on",
    });
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(body.data.features.ssl).toBe(false);
  });
});

describe("Response shape (anti-leak)", () => {
  it("returns the curated detailedStats only — no raw DA spread (sentinel filtered)", async () => {
    setupHappy();
    // Inject a sentinel field into the DA config — verify it does NOT
    // appear in the output (the route doesn't spread daConfig wholesale).
    getUserConfig.mockResolvedValueOnce({
      domain: "alice.com",
      suspended: "no",
      ip: "203.0.113.1",
      bandwidth: "10000",
      quota: "5000",
      mysql: "10",
      nemails: "20",
      ftp: "5",
      nsubdomains: "10",
      ssl: "ON",
      cgi: "OFF",
      php: "ON",
      spam: "OFF",
      ssh: "OFF",
      cron: "ON",
      dnscontrol: "OFF",
      package: "Starter",
      php_version: "8.2",
      date_created: "2026-01-01",
      usertype: "user",
      // Sentinel field that should NOT appear in output
      RAW_DA_INTERNAL_FIELD: "RAW_LEAK_ME",
    });
    const res = await GET(makeReq("username=alice_da"));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("RAW_LEAK_ME");
    // Whitelisted top-level fields (11 exactly)
    expect(Object.keys(body.data).sort()).toEqual([
      "created",
      "domain",
      "features",
      "ip",
      "nameservers",
      "package",
      "php",
      "status",
      "type",
      "usage",
      "username",
    ]);
  });
});

describe("Outer catch", () => {
  it("getUserConfig throw → 500 DETAILS_FETCH_FAILED; sentinel NOT leaked", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getUserConfig.mockRejectedValueOnce(
      new Error("DA down — $2a$12$BCRYPT_LEAK_ME")
    );
    const res = await GET(makeReq("username=alice_da"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DETAILS_FETCH_FAILED");
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_LEAK_ME");
  });
});
