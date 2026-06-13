/**
 * Tests for `app/api/domains/activate-dns/route.ts` (slice 7hu, part 1).
 *
 * Customer-side "activate DNS management on my domain" action.
 *
 * CRITICAL CONTRAST WITH ADMIN TWIN (`app/api/admin/domains/activate-dns/route.ts`,
 * tested in slice 7hm):
 *
 *   - **Admin version**: RC failure → local-mark STILL happens (admin can
 *     retry registrar manually; client-side recovery convenience).
 *   - **Customer version (THIS ROUTE)**: RC failure → 502 + LOCAL-MARK
 *     REFUSED. Customers can't fix a registrar mismatch themselves, so
 *     correctness wins: don't claim DNS is activated when the registrar
 *     hasn't confirmed.
 *
 * A future refactor that merges these two routes would break one workflow —
 * pinned per-route so the divergence is intentional and visible.
 *
 * Threat model:
 *  - **Cross-tenant DNS activation**: customer A activating DNS on
 *    customer B's domain → catastrophic, would let A take over B's
 *    DNS records. Pinned: `findOrderByDomainForUser` is keyed on
 *    the authed `user._id` (not body/query — the route doesn't
 *    accept any tenant override).
 *  - **Premature activation on a still-pending domain**: same as
 *    admin twin — refuses with 400.
 *  - **Silent re-activation**: `force` opt-in required.
 *
 * Other pins:
 *  - Auth gate → 401
 *  - zod: domainName trim+lower 3-253, force optional bool
 *  - findOrderByDomainForUser null → 404 "Domain not found"
 *  - findOrderDomain undefined → 404 "Domain not found in order"
 *  - status !== 'registered' → 400 "must be registered"
 *  - dnsActivated=true + !force → 400 "already activated"
 *  - No resellerOrderId at all → skip RC call; LOCAL-MARK happens
 *    (special-case — registrar-unaware records); pinned
 *  - Legacy top-level `order.resellerClubOrderId` fallback used
 *  - bookingStatus push with step='dns_activated' message+timestamp+progress:100
 *  - Outer catch → 500 generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const activateDNSManagement = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { activateDNSManagement },
}));

const findOrderByDomainForUser = vi.hoisted(() => vi.fn());
const findOrderDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  findOrderByDomainForUser,
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

import { POST } from "@/app/api/domains/activate-dns/route";

type FakeDomain = {
  domainName: string;
  status: string;
  dnsActivated?: boolean;
  dnsActivatedAt?: Date;
  resellerClubOrderId?: string;
  bookingStatus?: Array<{
    step: string;
    message: string;
    timestamp: Date;
    progress: number;
  }>;
};

type FakeOrder = {
  resellerClubOrderId?: string;
  domains: FakeDomain[];
  save: ReturnType<typeof vi.fn>;
};

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/domains/activate-dns",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue({ _id: "U1" });
  activateDNSManagement.mockReset();
  findOrderByDomainForUser.mockReset();
  findOrderDomain.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401; no order lookup", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(401);
    expect(findOrderByDomainForUser).not.toHaveBeenCalled();
  });
});

describe("Anti-IDOR — scoped lookup", () => {
  it("findOrderByDomainForUser keyed on the AUTHED user._id (NOT body override)", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    await POST(
      makeReq({
        domainName: "example.com",
        // Hostile attempt at tenant override
        userId: "U_OTHER",
      })
    );
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U1", "example.com");
  });
});

describe("Zod schema", () => {
  it("domain < 3 chars → 400", async () => {
    const res = await POST(makeReq({ domainName: "a" }));
    expect(res.status).toBe(400);
    expect(findOrderByDomainForUser).not.toHaveBeenCalled();
  });

  it("domain trim+lower before lookup", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    await POST(makeReq({ domainName: "  ExAmPle.COM  " }));
    expect(findOrderByDomainForUser).toHaveBeenCalledWith(
      "U1",
      "example.com"
    );
  });
});

describe("Lookup 404s", () => {
  it("findOrderByDomainForUser null → 404 'Domain not found'", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainName: "ghost.com" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found");
  });

  it("findOrderDomain undefined → 404 'Domain not found in order'", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({
      domains: [],
      save: vi.fn(),
    });
    findOrderDomain.mockReturnValueOnce(undefined);
    const res = await POST(makeReq({ domainName: "ghost.com" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found in order");
  });
});

describe("Status branch — must be 'registered'", () => {
  it("status='pending' → 400", async () => {
    const domain: FakeDomain = { domainName: "x.com", status: "pending" };
    findOrderByDomainForUser.mockResolvedValueOnce({
      domains: [domain],
      save: vi.fn(),
    });
    findOrderDomain.mockReturnValueOnce(domain);

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(400);
    expect(activateDNSManagement).not.toHaveBeenCalled();
  });

  it("status='failed' → 400", async () => {
    const domain: FakeDomain = { domainName: "x.com", status: "failed" };
    findOrderByDomainForUser.mockResolvedValueOnce({
      domains: [domain],
      save: vi.fn(),
    });
    findOrderDomain.mockReturnValueOnce(domain);
    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(400);
  });
});

describe("Already-activated guard + force-override", () => {
  it("dnsActivated=true + !force → 400 'already activated'; NO save", async () => {
    const domain: FakeDomain = {
      domainName: "x.com",
      status: "registered",
      dnsActivated: true,
    };
    const order: FakeOrder = {
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    };
    findOrderByDomainForUser.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(400);
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
    findOrderByDomainForUser.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);
    activateDNSManagement.mockResolvedValueOnce({ status: "success" });

    const res = await POST(makeReq({ domainName: "x.com", force: true }));
    expect(res.status).toBe(200);
    expect(order.save).toHaveBeenCalledTimes(1);
  });
});

describe("RC failure policy — CONTRAST WITH ADMIN TWIN", () => {
  function setup() {
    const domain: FakeDomain = {
      domainName: "x.com",
      status: "registered",
      resellerClubOrderId: "RC-1",
    };
    const order: FakeOrder = {
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    };
    findOrderByDomainForUser.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);
    return { domain, order };
  }

  it("RC throws → 502 + NO local-mark + NO save (opposite of admin twin's swallow)", async () => {
    const { domain, order } = setup();
    activateDNSManagement.mockRejectedValueOnce(
      new Error("ECONNREFUSED upstream-RC")
    );

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain("could not reach registrar");
    // Customer-side correctness: local-mark MUST NOT happen
    expect(domain.dnsActivated).toBeFalsy();
    expect(order.save).not.toHaveBeenCalled();
  });

  it("RC returns {status:'error'} → 502 + NO local-mark + NO save", async () => {
    const { domain, order } = setup();
    activateDNSManagement.mockResolvedValueOnce({
      status: "error",
      message: "RC: order in some bad state apk_LEAK_ME_NOT_HERE",
    });

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(502);
    expect(domain.dnsActivated).toBeFalsy();
    expect(order.save).not.toHaveBeenCalled();
    const body = await res.json();
    // RC-error path DOES pass through the message (customer-actionable copy)
    // — verify the route returns it but does NOT additionally local-mark.
    expect(body.error).toBeTruthy();
  });
});

describe("Happy path — RC succeeds; local-mark + bookingStatus + save", () => {
  function setup() {
    const domain: FakeDomain = {
      domainName: "x.com",
      status: "registered",
      resellerClubOrderId: "RC-1",
    };
    const order: FakeOrder = {
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    };
    findOrderByDomainForUser.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);
    return { domain, order };
  }

  it("RC success → 200, domain.dnsActivated=true, dnsActivatedAt=Date, save called", async () => {
    const { domain, order } = setup();
    activateDNSManagement.mockResolvedValueOnce({ status: "success" });

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(200);
    expect(domain.dnsActivated).toBe(true);
    expect(domain.dnsActivatedAt).toBeInstanceOf(Date);
    expect(order.save).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.domainName).toBe("x.com");
  });

  it("bookingStatus append: step='dns_activated', progress:100, timestamp set", async () => {
    const { domain } = setup();
    activateDNSManagement.mockResolvedValueOnce({ status: "success" });

    await POST(makeReq({ domainName: "x.com" }));
    expect(domain.bookingStatus).toBeInstanceOf(Array);
    expect(domain.bookingStatus!).toHaveLength(1);
    const appended = domain.bookingStatus![0];
    expect(appended.step).toBe("dns_activated");
    expect(appended.progress).toBe(100);
    expect(appended.message).toContain("DNS");
    expect(appended.timestamp).toBeInstanceOf(Date);
  });
});

describe("No-resellerOrderId branch", () => {
  it("no per-domain RC orderId AND no top-level → skip RC; local-mark STILL happens (registrar-unaware)", async () => {
    const domain: FakeDomain = {
      domainName: "x.com",
      status: "registered",
    };
    const order: FakeOrder = {
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    };
    findOrderByDomainForUser.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);

    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(200);
    expect(activateDNSManagement).not.toHaveBeenCalled();
    expect(domain.dnsActivated).toBe(true);
    expect(order.save).toHaveBeenCalledTimes(1);
  });

  it("LEGACY: top-level order.resellerClubOrderId used when per-domain absent", async () => {
    const domain: FakeDomain = {
      domainName: "x.com",
      status: "registered",
    };
    const order = {
      resellerClubOrderId: "LEGACY-RC-7",
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as FakeOrder;
    findOrderByDomainForUser.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(domain);
    activateDNSManagement.mockResolvedValueOnce({ status: "success" });

    await POST(makeReq({ domainName: "x.com" }));
    expect(activateDNSManagement).toHaveBeenCalledWith("x.com", "LEGACY-RC-7");
  });
});

describe("Outer catch", () => {
  it("findOrderByDomainForUser throw → 500 generic; sentinel NOT leaked", async () => {
    findOrderByDomainForUser.mockRejectedValueOnce(
      new Error("Mongo down — $2a$12$BCRYPT_LEAK_ME")
    );
    const res = await POST(makeReq({ domainName: "x.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to activate DNS management");
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_LEAK_ME");
  });
});
