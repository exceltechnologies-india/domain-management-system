/**
 * Tests for `app/api/admin/domains/activate-dns/route.ts` (slice 7hm, part 1).
 *
 * Admin "turn on DNS management" action for any customer's domain.
 *
 * Threat model:
 *  - **Non-admin uplift**: a session-authed user must NOT be able to
 *    flip DNS-management on for a domain they don't own.
 *    `getAdminFromRequest` returns null → 401.
 *  - **Premature activation on a pending domain**: activating DNS for a
 *    domain still in `pending`/`processing` would race the registrar's
 *    own write — pinned 400 with the "wait for registration" message.
 *  - **Silent re-activation**: re-running the action on an already-
 *    active domain must require an explicit `force: true` opt-in
 *    (avoids an idempotent retry quietly hitting the registrar twice).
 *
 * Other pins:
 *  - zod schema: domainName trimmed+lower-cased (3-253), force optional bool
 *  - findOrderByDomain null → 404 "Domain not found"
 *  - findOrderDomain null → 404 "Domain not found in order"
 *  - **Local-mark survives RC failure**: RC `activateDNSManagement`
 *    returning `status: "error"` OR throwing does NOT abort the route.
 *    `domain.dnsActivated = true` + `dnsActivatedAt = now` AND
 *    `order.save()` still run. Pinned because the comment explicitly
 *    says admin-side retry recovers this — a refactor that bails
 *    early would silently break that recovery path.
 *  - No resellerOrderId → warn-and-skip-RC; local-mark still happens.
 *  - Legacy top-level `order.resellerClubOrderId` fallback used when
 *    the per-domain `resellerClubOrderId` is absent.
 *  - Outer catch → 500 "Internal server error" (no upstream leak).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const activateDNSManagement = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { activateDNSManagement },
}));

const findOrderByDomain = vi.hoisted(() => vi.fn());
const findOrderDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  findOrderByDomain,
  findOrderDomain,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/domains/activate-dns/route";

type FakeDomain = {
  domainName: string;
  status: string;
  dnsActivated?: boolean;
  dnsActivatedAt?: Date;
  resellerClubOrderId?: string;
};

type FakeOrder = {
  resellerClubOrderId?: string;
  domains: FakeDomain[];
  save: ReturnType<typeof vi.fn>;
};

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/admin/domains/activate-dns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({ _id: "ADMIN1" });
  activateDNSManagement.mockReset();
  findOrderByDomain.mockReset();
  findOrderDomain.mockReset();
});

describe("Auth gate", () => {
  it("getAdminFromRequest null → 401; no order lookup", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(401);
    expect(findOrderByDomain).not.toHaveBeenCalled();
  });
});

describe("Zod schema", () => {
  it("domain < 3 chars → 400", async () => {
    const res = await POST(makeReq({ domainName: "a" }));
    expect(res.status).toBe(400);
    expect(findOrderByDomain).not.toHaveBeenCalled();
  });

  it("domain trimmed+lower-cased before downstream call", async () => {
    findOrderByDomain.mockResolvedValueOnce(null);
    await POST(makeReq({ domainName: "  ExAmPle.COM  " }));
    expect(findOrderByDomain).toHaveBeenCalledWith("example.com");
  });
});

describe("Order/domain lookup", () => {
  it("findOrderByDomain null → 404 'Domain not found'", async () => {
    findOrderByDomain.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainName: "ghost.com" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found");
  });

  it("findOrderDomain undefined → 404 'Domain not found in order'", async () => {
    const order: FakeOrder = { domains: [], save: vi.fn() };
    findOrderByDomain.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(undefined);
    const res = await POST(makeReq({ domainName: "ghost.com" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found in order");
  });
});

describe("Status branch — must be 'registered'", () => {
  it("status='pending' → 400 with wait-for-registration message", async () => {
    const domain: FakeDomain = { domainName: "x.com", status: "pending" };
    const order: FakeOrder = { domains: [domain], save: vi.fn() };
    findOrderByDomain.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("currently pending");
    expect(body.error.toLowerCase()).toContain("wait");
    expect(activateDNSManagement).not.toHaveBeenCalled();
    expect(order.save).not.toHaveBeenCalled();
  });

  it("status='processing' → 400 with same wait message", async () => {
    const domain: FakeDomain = { domainName: "x.com", status: "processing" };
    const order: FakeOrder = { domains: [domain], save: vi.fn() };
    findOrderByDomain.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("currently processing");
  });

  it("status='failed' → 400 with the generic 'must be registered' message", async () => {
    const domain: FakeDomain = { domainName: "x.com", status: "failed" };
    const order: FakeOrder = { domains: [domain], save: vi.fn() };
    findOrderByDomain.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      "Domain must be registered to activate DNS management"
    );
  });
});

describe("Already-activated guard + force-override", () => {
  it("dnsActivated=true + no force → 400 'already activated'; save NOT called", async () => {
    const domain: FakeDomain = {
      domainName: "x.com",
      status: "registered",
      dnsActivated: true,
    };
    const order: FakeOrder = { domains: [domain], save: vi.fn() };
    findOrderByDomain.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("already activated");
    expect(order.save).not.toHaveBeenCalled();
  });

  it("dnsActivated=true + force=true → proceeds to RC + save", async () => {
    const domain: FakeDomain = {
      domainName: "x.com",
      status: "registered",
      dnsActivated: true,
      resellerClubOrderId: "RC-1",
    };
    const order: FakeOrder = {
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    };
    findOrderByDomain.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);
    activateDNSManagement.mockResolvedValueOnce({ status: "success" });

    const res = await POST(makeReq({ domainName: "x.com", force: true }));
    expect(res.status).toBe(200);
    expect(order.save).toHaveBeenCalledTimes(1);
  });
});

describe("ResellerClub call — best-effort", () => {
  function setup(overrides: Partial<FakeDomain> = {}) {
    const domain: FakeDomain = {
      domainName: "x.com",
      status: "registered",
      resellerClubOrderId: "RC-1",
      ...overrides,
    };
    const order: FakeOrder = {
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    };
    findOrderByDomain.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);
    return { domain, order };
  }

  it("happy path → 200 success; local-mark + RC + save all ran", async () => {
    const { domain, order } = setup();
    activateDNSManagement.mockResolvedValueOnce({ status: "success" });

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(activateDNSManagement).toHaveBeenCalledWith("x.com", "RC-1");
    expect(domain.dnsActivated).toBe(true);
    expect(domain.dnsActivatedAt).toBeInstanceOf(Date);
    expect(order.save).toHaveBeenCalledTimes(1);
  });

  it("RC returns {status:'error'} → local-mark + save STILL run (recoverable)", async () => {
    const { domain, order } = setup();
    activateDNSManagement.mockResolvedValueOnce({
      status: "error",
      message: "RC: order in some bad state apk_LEAK_ME",
    });

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(domain.dnsActivated).toBe(true);
    expect(order.save).toHaveBeenCalledTimes(1);
    // RC's raw upstream message must NOT escape into the response.
    expect(JSON.stringify(body)).not.toContain("apk_LEAK_ME");
  });

  it("RC throws → local-mark + save STILL run (defensive — admin can retry)", async () => {
    const { domain, order } = setup();
    activateDNSManagement.mockRejectedValueOnce(
      new Error("ECONNREFUSED upstream-RC")
    );

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(200);
    expect(domain.dnsActivated).toBe(true);
    expect(order.save).toHaveBeenCalledTimes(1);
  });
});

describe("No-resellerOrderId branch", () => {
  it("absent per-domain RC orderId AND absent top-level → skip RC call; local-mark still happens", async () => {
    const domain: FakeDomain = {
      domainName: "x.com",
      status: "registered",
      // No resellerClubOrderId on the domain
    };
    const order: FakeOrder = {
      // No top-level resellerClubOrderId either
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    };
    findOrderByDomain.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(200);
    expect(activateDNSManagement).not.toHaveBeenCalled();
    expect(domain.dnsActivated).toBe(true);
    expect(order.save).toHaveBeenCalledTimes(1);
  });

  it("LEGACY: top-level order.resellerClubOrderId is used when per-domain absent", async () => {
    const domain: FakeDomain = {
      domainName: "x.com",
      status: "registered",
      // No per-domain RC orderId
    };
    const order = {
      resellerClubOrderId: "LEGACY-RC-7",
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as FakeOrder;
    findOrderByDomain.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);
    activateDNSManagement.mockResolvedValueOnce({ status: "success" });

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(200);
    expect(activateDNSManagement).toHaveBeenCalledWith("x.com", "LEGACY-RC-7");
  });
});

describe("Outer catch", () => {
  it("findOrderByDomain throw → 500 generic; sentinel NOT leaked", async () => {
    findOrderByDomain.mockRejectedValueOnce(
      new Error("Mongo down — token $2a$12$BCRYPT_HASH_LEAK_ME")
    );
    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_HASH_LEAK_ME");
  });
});
