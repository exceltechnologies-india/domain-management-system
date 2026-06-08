/**
 * Tests for `app/api/user/domains/dns/route.ts` (slice 7gk).
 * Customer DNS-management list endpoint. Powers the front-end DNS
 * editor — every domain returned here becomes editable in the
 * customer UI, so a leak here is an authorisation leak.
 *
 * Pins:
 *  - Auth gate FIRST → 401 (NO order/domain queries)
 *  - **Both** list calls are scoped on user._id (listOrdersForUser
 *    + listDomainsForUser). NEVER on a request param. listOrders
 *    called with limit:0 (DNS view flattens domains across every
 *    order — the default 50-row cap would silently hide some)
 *  - **registered-only filter** — domains with status 'pending' /
 *    'processing' / 'failed' / 'cancelled' / anything other than
 *    'registered' are SKIPPED. (Mid-purchase domains have no DNS
 *    yet; failed ones must not show up as editable; the UI infers
 *    "you can edit this" from the response shape.)
 *  - **Cross-order dedupe by domainName** — same domain appearing
 *    on multiple orders must yield ONE row in the response; the
 *    `registered` status wins over earlier non-registered records
 *    (handles the case where a renewal order overrides a stale
 *    pending status on the same domain)
 *  - **Domain.id resolution**: from listDomainsForUser map by
 *    domainName. Fallback to `${order._id}_${domainName}` only
 *    when the Domain row is missing (shouldn't happen for
 *    registered domains; pinned to catch a future refactor that
 *    drops the fallback)
 *  - **Date formatting**: registrationDate = order.createdAt.
 *    toISOString().split('T')[0] (YYYY-MM-DD); expiryDate same
 *    or null when missing
 *  - **Field defaults**: dnsActivated → false, dnsProvider →
 *    'resellerclub' (when not set on the order domain entry)
 *  - Outer catch → 500 'Internal server error' (no internals
 *    leaked — DNS list is a public-from-UI surface)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const listOrdersForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ listOrdersForUser }));

const listDomainsForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/domains", () => ({ listDomainsForUser }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/user/domains/dns/route";

function makeReq() {
  return new NextRequest("https://example.com/api/user/domains/dns", {
    method: "GET",
  });
}

const user = { _id: "U1", email: "alice@example.com" };

function freshDomain(overrides: Record<string, unknown> = {}) {
  return {
    domainName: "alice.com",
    status: "registered",
    expiresAt: new Date("2027-01-01"),
    resellerClubOrderId: "RC-1",
    resellerClubCustomerId: "RC-CUST-1",
    resellerClubContactId: "RC-CONT-1",
    dnsActivated: true,
    dnsActivatedAt: new Date("2026-01-15"),
    dnsProvider: "resellerclub",
    bookingStatus: [],
    ...overrides,
  };
}

function freshOrder(overrides: Record<string, unknown> = {}) {
  return {
    _id: "O1",
    orderId: "ORD-1",
    createdAt: new Date("2026-01-01"),
    domains: [freshDomain()],
    ...overrides,
  };
}

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  listOrdersForUser.mockReset();
  listDomainsForUser.mockReset();
});

// ─── Auth gate ────────────────────────────────────────────────────
describe("Auth gate FIRST", () => {
  it("no user → 401; NO order or domain queries", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(listOrdersForUser).not.toHaveBeenCalled();
    expect(listDomainsForUser).not.toHaveBeenCalled();
  });
});

// ─── IDOR scope ───────────────────────────────────────────────────
describe("IDOR scope — both lists keyed by user._id", () => {
  it("listOrdersForUser called with String(user._id) AND limit:0 (no default 50-row cap)", async () => {
    listOrdersForUser.mockResolvedValueOnce([]);
    listDomainsForUser.mockResolvedValueOnce([]);
    await GET(makeReq());
    expect(listOrdersForUser).toHaveBeenCalledWith("U1", { limit: 0 });
  });

  it("listDomainsForUser called with String(user._id)", async () => {
    listOrdersForUser.mockResolvedValueOnce([]);
    listDomainsForUser.mockResolvedValueOnce([]);
    await GET(makeReq());
    expect(listDomainsForUser).toHaveBeenCalledWith("U1");
  });
});

// ─── registered-only filter ───────────────────────────────────────
describe("registered-only filter (anti-pre-DNS-edit leakage)", () => {
  it("status='pending' SKIPPED — never returned to the DNS editor", async () => {
    listOrdersForUser.mockResolvedValueOnce([
      freshOrder({
        domains: [freshDomain({ status: "pending" })],
      }),
    ]);
    listDomainsForUser.mockResolvedValueOnce([]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it.each(["processing", "failed", "cancelled", "registering", "expired"])(
    "status=%p SKIPPED",
    async (status) => {
      listOrdersForUser.mockResolvedValueOnce([
        freshOrder({ domains: [freshDomain({ status })] }),
      ]);
      listDomainsForUser.mockResolvedValueOnce([]);

      const res = await GET(makeReq());
      const body = await res.json();
      expect(body.domains).toHaveLength(0);
    }
  );

  it("'registered' passes through", async () => {
    listOrdersForUser.mockResolvedValueOnce([freshOrder()]);
    listDomainsForUser.mockResolvedValueOnce([
      { domainName: "alice.com", _id: "D1" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].name).toBe("alice.com");
  });
});

// ─── Cross-order dedupe ───────────────────────────────────────────
describe("Cross-order dedupe by domainName", () => {
  it("same domain across two orders, both 'registered' → ONE row", async () => {
    listOrdersForUser.mockResolvedValueOnce([
      freshOrder({ _id: "O1", orderId: "ORD-1" }),
      freshOrder({ _id: "O2", orderId: "ORD-2" }),
    ]);
    listDomainsForUser.mockResolvedValueOnce([
      { domainName: "alice.com", _id: "D1" },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});

// ─── Domain.id resolution from listDomainsForUser map ─────────────
describe("Domain.id resolution", () => {
  it("uses Domain._id from listDomainsForUser map (string-converted)", async () => {
    listOrdersForUser.mockResolvedValueOnce([freshOrder()]);
    listDomainsForUser.mockResolvedValueOnce([
      {
        domainName: "alice.com",
        _id: { toString: () => "DOC_507f1f77bcf86cd799439011" },
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains[0].id).toBe("DOC_507f1f77bcf86cd799439011");
  });

  it("falls back to `${order._id}_${domainName}` when Domain row missing", async () => {
    listOrdersForUser.mockResolvedValueOnce([freshOrder()]);
    listDomainsForUser.mockResolvedValueOnce([]); // No Domain rows
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains[0].id).toBe("O1_alice.com");
  });
});

// ─── Date formatting ──────────────────────────────────────────────
describe("Date formatting (YYYY-MM-DD)", () => {
  it("registrationDate = order.createdAt → ISO date (no time)", async () => {
    listOrdersForUser.mockResolvedValueOnce([
      freshOrder({ createdAt: new Date("2026-03-14T10:30:00.000Z") }),
    ]);
    listDomainsForUser.mockResolvedValueOnce([
      { domainName: "alice.com", _id: "D1" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains[0].registrationDate).toBe("2026-03-14");
  });

  it("expiryDate ISO date when set; null when domain.expiresAt missing", async () => {
    listOrdersForUser.mockResolvedValueOnce([
      freshOrder({
        domains: [
          freshDomain({ expiresAt: new Date("2028-12-31T23:59:00.000Z") }),
          freshDomain({
            domainName: "noexp.com",
            expiresAt: undefined,
          }),
        ],
      }),
    ]);
    listDomainsForUser.mockResolvedValueOnce([
      { domainName: "alice.com", _id: "D1" },
      { domainName: "noexp.com", _id: "D2" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    const a = body.domains.find((d: { name: string }) => d.name === "alice.com");
    const n = body.domains.find((d: { name: string }) => d.name === "noexp.com");
    expect(a.expiryDate).toBe("2028-12-31");
    expect(n.expiryDate).toBeNull();
  });
});

// ─── Field defaults ───────────────────────────────────────────────
describe("Field defaults", () => {
  it("dnsActivated default false when undefined; dnsProvider default 'resellerclub'", async () => {
    listOrdersForUser.mockResolvedValueOnce([
      freshOrder({
        domains: [
          freshDomain({
            dnsActivated: undefined,
            dnsProvider: undefined,
          }),
        ],
      }),
    ]);
    listDomainsForUser.mockResolvedValueOnce([
      { domainName: "alice.com", _id: "D1" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains[0].dnsActivated).toBe(false);
    expect(body.domains[0].dnsProvider).toBe("resellerclub");
  });

  it("explicit dnsActivated=true preserved", async () => {
    listOrdersForUser.mockResolvedValueOnce([
      freshOrder({ domains: [freshDomain({ dnsActivated: true })] }),
    ]);
    listDomainsForUser.mockResolvedValueOnce([
      { domainName: "alice.com", _id: "D1" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.domains[0].dnsActivated).toBe(true);
  });
});

// ─── Response shape ───────────────────────────────────────────────
describe("Response shape", () => {
  it("returns { success, domains, total } with total === domains.length", async () => {
    listOrdersForUser.mockResolvedValueOnce([
      freshOrder({
        domains: [
          freshDomain({ domainName: "a.com" }),
          freshDomain({ domainName: "b.com" }),
          freshDomain({ domainName: "c.com" }),
        ],
      }),
    ]);
    listDomainsForUser.mockResolvedValueOnce([
      { domainName: "a.com", _id: "DA" },
      { domainName: "b.com", _id: "DB" },
      { domainName: "c.com", _id: "DC" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.domains).toHaveLength(3);
    expect(body.total).toBe(3);
  });
});

// ─── Outer catch ──────────────────────────────────────────────────
describe("Outer catch", () => {
  it("listOrdersForUser throw → 500 'Internal server error' (no leak)", async () => {
    listOrdersForUser.mockRejectedValueOnce(new Error("DB exploded"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("DB exploded");
  });

  it("listDomainsForUser throw → 500", async () => {
    listOrdersForUser.mockResolvedValueOnce([freshOrder()]);
    listDomainsForUser.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });
});
