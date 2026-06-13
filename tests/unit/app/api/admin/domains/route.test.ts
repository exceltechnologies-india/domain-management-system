/**
 * Tests for `app/api/admin/domains/route.ts` (slice 7i0, part 2).
 *
 * Admin "registered domains" master list. Powers the DNS-management
 * dashboard's domain picker.
 *
 * Threat model:
 *  - **Pending-domain leak into active list**: a domain that's in the
 *    PendingDomain queue (under manual review) but happens to be
 *    marked status:'registered' in an Order row would otherwise be
 *    DNS-editable from the admin panel — bypassing the review. Pinned.
 *  - **Duplicate-domain row picking the wrong copy**: when a domain
 *    appears in multiple orders, the dedup priority determines which
 *    row's DNS settings the admin sees. Pinned with a 3-step priority
 *    chain.
 *  - **Page limit DoS**: ?limit=10000 would dump every domain on the
 *    server. Pinned at MAX=100.
 *
 * Other pins:
 *  - Admin gate → 401
 *  - Pagination: page ≥ 1; limit ∈ [1, 100] default 50
 *  - itemType filter: only 'domain' (or undefined → 'domain' for legacy)
 *  - status filter: only 'registered' (pending/processing/failed/
 *    cancelled all skipped)
 *  - Pending-domain Set filter (case-insensitive, trimmed)
 *  - 3-step dedup priority:
 *      (1) dnsActivated entry wins over non-activated
 *      (2) same dnsActivated → resellerClubOrderId entry wins
 *      (3) same DNS + same RC orderId → newer createdAt wins
 *  - Customer name/email from populated user; 'Unknown' fallback
 *  - RC orderId fallback chain: domain.resellerClubOrderId →
 *    domain.orderId → top-level order.resellerClubOrderId
 *  - Response: { success, domains, pagination: { page, limit, total,
 *    totalPages, hasMore } }
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const listAllOrdersForAdminDomains = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  listAllOrdersForAdminDomains,
}));

const listAllPendingDomainNames = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-domains", () => ({
  listAllPendingDomainNames,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/domains/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/admin/domains?${qs}`
    : "https://example.com/api/admin/domains";
  return new NextRequest(url, { method: "GET" });
}

function makeRegisteredDomain(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => "D1" },
    domainName: "example.com",
    status: "registered",
    itemType: "domain",
    price: 999,
    currency: "INR",
    registrationPeriod: 1,
    expiresAt: new Date("2027-01-01"),
    resellerClubOrderId: "RC-1",
    dnsActivated: false,
    dnsActivatedAt: null,
    ...overrides,
  };
}

function makeOrder(
  domain: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    _id: "O1",
    orderId: "ORD-1",
    createdAt: new Date("2026-01-01"),
    userId: {
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
    },
    domains: [domain],
    ...overrides,
  };
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({ _id: "ADMIN1" });
  listAllOrdersForAdminDomains.mockReset().mockResolvedValue([]);
  listAllPendingDomainNames.mockReset().mockResolvedValue([]);
});

describe("Admin gate", () => {
  it("non-admin → 401; no DB read", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(listAllOrdersForAdminDomains).not.toHaveBeenCalled();
  });
});

describe("Pagination clamps", () => {
  it("page=0 → clamped to 1", async () => {
    const res = await GET(makeReq("page=0"));
    const body = await res.json();
    expect(body.pagination.page).toBe(1);
  });

  it("page=-5 → clamped to 1", async () => {
    const res = await GET(makeReq("page=-5"));
    const body = await res.json();
    expect(body.pagination.page).toBe(1);
  });

  it("limit=200 → clamped to 100 (MAX_DOMAINS_PAGE_SIZE)", async () => {
    const res = await GET(makeReq("limit=200"));
    const body = await res.json();
    expect(body.pagination.limit).toBe(100);
  });

  it("limit=0 → clamped to 1", async () => {
    const res = await GET(makeReq("limit=0"));
    const body = await res.json();
    expect(body.pagination.limit).toBe(1);
  });

  it("default page=1 limit=50", async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(50);
  });
});

describe("itemType + status filters", () => {
  it("itemType='hosting' → skipped (not in list)", async () => {
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder({
        ...makeRegisteredDomain(),
        itemType: "hosting",
      }),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(0);
  });

  it("itemType=undefined → defaults to 'domain'; INCLUDED", async () => {
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder({
        ...makeRegisteredDomain(),
        itemType: undefined,
      }),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
  });

  it("status='pending' → skipped", async () => {
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder({ ...makeRegisteredDomain(), status: "pending" }),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(0);
  });

  it("status='processing'/'failed'/'cancelled' all skipped", async () => {
    for (const status of ["processing", "failed", "cancelled"]) {
      listAllOrdersForAdminDomains.mockResolvedValueOnce([
        makeOrder({ ...makeRegisteredDomain(), status }),
      ]);
      const res = await GET(makeReq());
      const body = await res.json();
      expect(body.domains).toHaveLength(0);
    }
  });
});

describe("Pending-domain Set filter", () => {
  it("**CRITICAL: domain in PendingDomain queue → EXCLUDED from active list (even if status='registered')**", async () => {
    listAllPendingDomainNames.mockResolvedValueOnce([
      { domainName: "Under-Review.com" },
    ]);
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder({
        ...makeRegisteredDomain(),
        domainName: "under-review.com",
        status: "registered",
      }),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(0);
  });

  it("pending-name match is case-insensitive + trimmed", async () => {
    listAllPendingDomainNames.mockResolvedValueOnce([
      { domainName: "  EXAMPLE.COM  " },
    ]);
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder({ ...makeRegisteredDomain(), domainName: "example.com" }),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(0);
  });
});

describe("Customer info + RC orderId fallback chain", () => {
  it("populated user → name 'First Last' + email; missing → 'Unknown'", async () => {
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder(makeRegisteredDomain(), {
        userId: {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        },
      }),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains[0].customerName).toBe("Alice Smith");
    expect(body.domains[0].customerEmail).toBe("alice@example.com");
  });

  it("user not populated (null) → 'Unknown' name + email", async () => {
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder(makeRegisteredDomain(), { userId: null }),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains[0].customerName).toBe("Unknown");
    expect(body.domains[0].customerEmail).toBe("Unknown");
  });

  it("RC orderId fallback: domain.resellerClubOrderId → domain.orderId → order.resellerClubOrderId", async () => {
    // case 1: domain.resellerClubOrderId present
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder({
        ...makeRegisteredDomain(),
        domainName: "a.com",
        resellerClubOrderId: "RC-A",
        orderId: "ORDER-A",
      }),
    ]);
    let res = await GET(makeReq());
    let body = await res.json();
    expect(body.domains[0].resellerClubOrderId).toBe("RC-A");

    // case 2: no domain.resellerClubOrderId → falls to domain.orderId
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder({
        ...makeRegisteredDomain(),
        domainName: "b.com",
        resellerClubOrderId: undefined,
        orderId: "DOMAIN-ORDER-B",
      }),
    ]);
    res = await GET(makeReq());
    body = await res.json();
    expect(body.domains[0].resellerClubOrderId).toBe("DOMAIN-ORDER-B");

    // case 3: neither → falls to order.resellerClubOrderId (legacy)
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder(
        {
          ...makeRegisteredDomain(),
          domainName: "c.com",
          resellerClubOrderId: undefined,
          orderId: undefined,
        },
        { resellerClubOrderId: "LEGACY-RC-C" }
      ),
    ]);
    res = await GET(makeReq());
    body = await res.json();
    expect(body.domains[0].resellerClubOrderId).toBe("LEGACY-RC-C");
  });
});

describe("3-step dedup priority", () => {
  it("(1) dnsActivated entry wins over non-activated", async () => {
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder(
        {
          ...makeRegisteredDomain(),
          domainName: "shared.com",
          dnsActivated: false,
        },
        { _id: "O_NO_DNS", createdAt: new Date("2026-02-01") }
      ),
      makeOrder(
        {
          ...makeRegisteredDomain(),
          domainName: "shared.com",
          dnsActivated: true,
        },
        { _id: "O_DNS_ON", createdAt: new Date("2026-01-01") }
      ),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].dnsActivated).toBe(true);
  });

  it("(2) same dnsActivated → resellerClubOrderId entry wins", async () => {
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder(
        {
          ...makeRegisteredDomain(),
          domainName: "shared.com",
          dnsActivated: false,
          resellerClubOrderId: undefined,
          orderId: undefined,
        },
        { _id: "O_NO_RC" }
      ),
      makeOrder(
        {
          ...makeRegisteredDomain(),
          domainName: "shared.com",
          dnsActivated: false,
          resellerClubOrderId: "RC-WINNER",
        },
        { _id: "O_WITH_RC" }
      ),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].resellerClubOrderId).toBe("RC-WINNER");
  });

  it("(3) same DNS + same RC orderId-presence → newer createdAt wins", async () => {
    listAllOrdersForAdminDomains.mockResolvedValueOnce([
      makeOrder(
        {
          ...makeRegisteredDomain(),
          domainName: "shared.com",
          dnsActivated: false,
          resellerClubOrderId: "RC-OLD",
        },
        { _id: "O_OLD", createdAt: new Date("2026-01-01"), orderId: "OLD" }
      ),
      makeOrder(
        {
          ...makeRegisteredDomain(),
          domainName: "shared.com",
          dnsActivated: false,
          resellerClubOrderId: "RC-NEW",
        },
        { _id: "O_NEW", createdAt: new Date("2026-06-01"), orderId: "NEW" }
      ),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].orderId).toBe("NEW");
  });
});

describe("Pagination math + response shape", () => {
  it("25 domains + limit=10&page=1 → 10 returned, totalPages=3, hasMore=true", async () => {
    const domains = Array.from({ length: 25 }, (_, i) =>
      makeOrder(
        {
          ...makeRegisteredDomain(),
          domainName: `d${String(i).padStart(2, "0")}.com`,
        },
        { _id: `O${i}`, orderId: `ORD-${i}` }
      )
    );
    listAllOrdersForAdminDomains.mockResolvedValueOnce(domains);
    const res = await GET(makeReq("limit=10&page=1"));
    const body = await res.json();
    expect(body.domains).toHaveLength(10);
    expect(body.pagination).toEqual(
      expect.objectContaining({
        page: 1,
        limit: 10,
        total: 25,
        totalPages: 3,
        hasMore: true,
      })
    );
  });

  it("last page → hasMore=false", async () => {
    const domains = Array.from({ length: 25 }, (_, i) =>
      makeOrder(
        { ...makeRegisteredDomain(), domainName: `d${i}.com` },
        { _id: `O${i}`, orderId: `ORD-${i}` }
      )
    );
    listAllOrdersForAdminDomains.mockResolvedValueOnce(domains);
    const res = await GET(makeReq("limit=10&page=3"));
    const body = await res.json();
    expect(body.domains).toHaveLength(5);
    expect(body.pagination.hasMore).toBe(false);
  });
});

describe("Outer catch", () => {
  it("listAllOrdersForAdminDomains throw → 500", async () => {
    listAllOrdersForAdminDomains.mockRejectedValueOnce(
      new Error("Mongo down")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch domains");
  });
});
