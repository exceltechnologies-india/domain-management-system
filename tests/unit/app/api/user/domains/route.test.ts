/**
 * Tests for `app/api/user/domains/route.ts` (slice 7hx, part 1).
 *
 * Customer "my domains" dashboard list. Aggregates 3 sources
 * (Domain collection, PendingDomain collection, recent Orders)
 * with deduplication.
 *
 * Threat model:
 *  - **Cross-tenant data leak via dedup**: each source's lookup is
 *    keyed on user._id; a refactor that bypassed user scoping on
 *    any single source would surface other customers' domains.
 *    Pinned: all three queries called with the AUTHED user._id.
 *  - **Deactivated-but-token-still-valid uplift**: NextAuth-session
 *    path checks `user.isActive` — pinned with explicit 401 on
 *    isActive=false.
 *  - **Hosting line-item leak**: if a refactor drops the hosting
 *    filter, hosting plans appear in the "my domains" view (UX
 *    broken + confusion). Pinned via both itemType='hosting' AND
 *    isHostingItem(d) double-check.
 *
 * Other pins:
 *  - Dual auth: JWT first; NextAuth getToken fallback
 *  - 14-day window on order source
 *  - Map dedup priority: Order < PendingDomain < Domain (later
 *    Map.set wins — Domain source is last so it overrides)
 *  - Domain name lowercased + trimmed before Map.set
 *  - Skip isDeleted orders; skip failed/cancelled domains in orders
 *  - Sort by registrationDate desc; missing date treated as 0
 *  - Pagination: ?limit=N&page=M; page clamped ≥1
 *  - Status filter applied AFTER aggregation
 *  - Response: { success, domains, total, +page+limit+hasMore when paginated }
 *  - Outer catch → 500 DOMAINS_FETCH_FAILED
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getToken = vi.hoisted(() => vi.fn());
vi.mock("next-auth/jwt", () => ({ getToken }));

vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET: "test-secret" }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const listDomainsForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/domains", () => ({ listDomainsForUser }));

const listActivePendingDomainsForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-domains", () => ({
  listActivePendingDomainsForUser,
}));

const listRecentCompletedOrdersForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  listRecentCompletedOrdersForUser,
}));

const isHostingItem = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing", () => ({ isHostingItem }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/user/domains/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/user/domains?${qs}`
    : "https://example.com/api/user/domains";
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  getUserFromRequest.mockReset();
  getToken.mockReset();
  getUserById.mockReset();
  listDomainsForUser.mockReset().mockResolvedValue([]);
  listActivePendingDomainsForUser.mockReset().mockResolvedValue([]);
  listRecentCompletedOrdersForUser.mockReset().mockResolvedValue([]);
  isHostingItem.mockReset().mockReturnValue(false);
});

describe("Dual auth — JWT first, NextAuth fallback", () => {
  it("JWT user → proceeds; NextAuth NOT consulted", async () => {
    getUserFromRequest.mockResolvedValueOnce({ _id: "U1", isActive: true });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("no JWT → falls to NextAuth; valid token + active user → 200", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", isActive: true });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it("no JWT + no NextAuth token → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("NextAuth token + isActive=false → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", isActive: false });
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(listDomainsForUser).not.toHaveBeenCalled();
  });
});

describe("Per-source user-ID scoping", () => {
  it("all three source queries keyed on session user._id (anti-IDOR)", async () => {
    getUserFromRequest.mockResolvedValueOnce({ _id: "U1", isActive: true });
    await GET(makeReq());
    expect(listRecentCompletedOrdersForUser).toHaveBeenCalledWith(
      "U1",
      expect.objectContaining({ withinDays: 14 })
    );
    expect(listActivePendingDomainsForUser).toHaveBeenCalledWith("U1");
    expect(listDomainsForUser).toHaveBeenCalledWith("U1");
  });
});

describe("Order source filters", () => {
  beforeEach(() => {
    getUserFromRequest.mockResolvedValue({ _id: "U1", isActive: true });
  });

  it("isDeleted order skipped entirely", async () => {
    listRecentCompletedOrdersForUser.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-1",
        isDeleted: true,
        createdAt: new Date(),
        domains: [{ domainName: "deleted.com", status: "registered" }],
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(0);
  });

  it("hosting itemType skipped", async () => {
    listRecentCompletedOrdersForUser.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-1",
        createdAt: new Date(),
        domains: [
          { domainName: "host.com", status: "registered", itemType: "hosting" },
          { domainName: "domain.com", status: "registered", itemType: "domain" },
        ],
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].name).toBe("domain.com");
  });

  it("isHostingItem helper also filters out hosting (double-check)", async () => {
    isHostingItem.mockImplementation(
      (d: { domainName: string }) => d.domainName === "host.com"
    );
    listRecentCompletedOrdersForUser.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-1",
        createdAt: new Date(),
        domains: [
          { domainName: "host.com", status: "registered" }, // no itemType
          { domainName: "domain.com", status: "registered" },
        ],
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].name).toBe("domain.com");
  });

  it("failed/cancelled status skipped", async () => {
    listRecentCompletedOrdersForUser.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-1",
        createdAt: new Date(),
        domains: [
          { domainName: "ok.com", status: "registered" },
          { domainName: "fail.com", status: "failed" },
          { domainName: "cancel.com", status: "cancelled" },
        ],
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].name).toBe("ok.com");
  });

  it("empty/missing domainName skipped", async () => {
    listRecentCompletedOrdersForUser.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-1",
        createdAt: new Date(),
        domains: [
          { domainName: "", status: "registered" },
          { status: "registered" }, // no domainName at all
          { domainName: "ok.com", status: "registered" },
        ],
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].name).toBe("ok.com");
  });
});

describe("3-source dedup priority (Order < Pending < Domain)", () => {
  beforeEach(() => {
    getUserFromRequest.mockResolvedValue({ _id: "U1", isActive: true });
  });

  it("Domain source OVERRIDES Pending and Order (last Map.set wins)", async () => {
    const sharedName = "shared.com";
    listRecentCompletedOrdersForUser.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-1",
        createdAt: new Date("2026-01-01"),
        domains: [{ domainName: sharedName, status: "pending" }],
      },
    ]);
    listActivePendingDomainsForUser.mockResolvedValueOnce([
      {
        _id: "P1",
        domainName: sharedName,
        status: "processing",
        createdAt: new Date("2026-02-01"),
      },
    ]);
    listDomainsForUser.mockResolvedValueOnce([
      {
        _id: "D1",
        domainName: sharedName,
        status: "registered",
        registeredAt: new Date("2026-03-01"),
        nameservers: ["ns1.example.com"],
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0]).toEqual(
      expect.objectContaining({
        status: "registered",
        isFromDomain: true,
        registrar: "Domain Services",
      })
    );
  });

  it("Pending OVERRIDES Order (when no Domain row)", async () => {
    listRecentCompletedOrdersForUser.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-1",
        createdAt: new Date(),
        domains: [{ domainName: "x.com", status: "pending" }],
      },
    ]);
    listActivePendingDomainsForUser.mockResolvedValueOnce([
      {
        _id: "P1",
        domainName: "x.com",
        status: "processing",
        createdAt: new Date(),
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0]).toEqual(
      expect.objectContaining({
        status: "processing",
        isFromPending: true,
      })
    );
  });

  it("case-insensitive dedup: 'Example.com' from Order + 'example.com' from Domain → 1 entry from Domain", async () => {
    listRecentCompletedOrdersForUser.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-1",
        createdAt: new Date(),
        domains: [{ domainName: "Example.com", status: "pending" }],
      },
    ]);
    listDomainsForUser.mockResolvedValueOnce([
      { _id: "D1", domainName: "example.com", status: "registered" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].isFromDomain).toBe(true);
  });
});

describe("Sorting", () => {
  beforeEach(() => {
    getUserFromRequest.mockResolvedValue({ _id: "U1", isActive: true });
  });

  it("registrationDate desc — newest first", async () => {
    listDomainsForUser.mockResolvedValueOnce([
      {
        _id: "D1",
        domainName: "old.com",
        status: "registered",
        registeredAt: new Date("2024-01-01"),
      },
      {
        _id: "D2",
        domainName: "new.com",
        status: "registered",
        registeredAt: new Date("2026-01-01"),
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains[0].name).toBe("new.com");
    expect(body.domains[1].name).toBe("old.com");
  });

  it("missing registrationDate treated as 0 (sorts last)", async () => {
    listDomainsForUser.mockResolvedValueOnce([
      {
        _id: "D1",
        domainName: "dated.com",
        status: "registered",
        registeredAt: new Date("2026-01-01"),
      },
      {
        _id: "D2",
        domainName: "no-date.com",
        status: "registered",
        // no registeredAt
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains[0].name).toBe("dated.com");
    expect(body.domains[1].name).toBe("no-date.com");
  });
});

describe("Pagination + status filter", () => {
  beforeEach(() => {
    getUserFromRequest.mockResolvedValue({ _id: "U1", isActive: true });
    listDomainsForUser.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({
        _id: `D${i}`,
        domainName: `d${String(i).padStart(2, "0")}.com`,
        status: i < 15 ? "registered" : "pending",
        registeredAt: new Date(`2026-01-${String(i + 1).padStart(2, "0")}`),
      }))
    );
  });

  it("no limit → returns ALL (back-compat); response has NO page/limit/hasMore", async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(25);
    expect(body.total).toBe(25);
    expect(body.page).toBeUndefined();
    expect(body.hasMore).toBeUndefined();
  });

  it("limit=10&page=1 → first 10; hasMore=true", async () => {
    const res = await GET(makeReq("limit=10&page=1"));
    const body = await res.json();
    expect(body.domains).toHaveLength(10);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(10);
    expect(body.total).toBe(25);
    expect(body.hasMore).toBe(true);
  });

  it("limit=10&page=3 → last 5; hasMore=false", async () => {
    const res = await GET(makeReq("limit=10&page=3"));
    const body = await res.json();
    expect(body.domains).toHaveLength(5);
    expect(body.hasMore).toBe(false);
  });

  it("page=0 or negative → clamped to 1 (NaN/<1 floor)", async () => {
    const res = await GET(makeReq("limit=10&page=0"));
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.domains).toHaveLength(10);
  });

  it("?status=registered → only registered (filter applied)", async () => {
    const res = await GET(makeReq("status=registered"));
    const body = await res.json();
    expect(body.total).toBe(15);
    expect(body.domains.every((d: { status: string }) => d.status === "registered")).toBe(true);
  });
});

describe("Outer catch", () => {
  it("listDomainsForUser throw → 500 DOMAINS_FETCH_FAILED", async () => {
    getUserFromRequest.mockResolvedValueOnce({ _id: "U1", isActive: true });
    listDomainsForUser.mockRejectedValueOnce(
      new Error("Mongo down — apk_LEAK_ME")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DOMAINS_FETCH_FAILED");
    expect(JSON.stringify(body)).not.toContain("apk_LEAK_ME");
  });
});
