/**
 * Tests for `app/api/domains/renew/route.ts` (slice 7hw, part 2).
 *
 * Customer-initiated domain renewal: GET fetches renewal pricing +
 * expiry; POST executes the renewal after payment confirmation.
 *
 * Threat model:
 *  - **Order/domain-list write on FAILED renewal**: a refactor that
 *    writes createOrder + appendUserDomain BEFORE checking the RC
 *    outcome would leave phantom "renewed" rows when the registrar
 *    rejected. Pinned: both balance_pending AND hard_failure
 *    branches MUST skip BOTH writes.
 *  - **Years bound bypass via float / 0 / negative**: zod must
 *    enforce positive integer ≤10. Pinned with multiple bad-value
 *    probes.
 *
 * Other pins:
 *  - GET zod query: domainName trim+lower 3-253; years coerced int
 *    1-10 default-1
 *  - POST zod body: paymentId required (≥1 char)
 *  - GET pricing error → 500 with the RC message
 *  - POST 3-branch outcome dispatch:
 *      renewed → 200 + createOrder + appendUserDomain + new-expiry-date
 *      balance_pending → 202 + queued message + NO writes
 *      hard_failure → 500 + generic message + NO writes
 *  - new-expiry = now + years × 365 × 86_400_000 (matches the route's
 *    inline math)
 *  - createOrder + appendUserDomain mirror each other (same domain,
 *    price, orderId, status='registered')
 *  - userName fallback to empty-trimmed if names absent (template-
 *    literal quirk pinned)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getRenewalPricing = vi.hoisted(() => vi.fn());
const getDomainExpiry = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { getRenewalPricing, getDomainExpiry },
}));

const rcRenewDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/resellerclub", () => ({
  renewDomain: rcRenewDomain,
}));

const createOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ createOrder }));

const appendUserDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ appendUserDomain }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/domains/renew/route";

function makeGet(qs = "") {
  const url = qs
    ? `https://example.com/api/domains/renew?${qs}`
    : "https://example.com/api/domains/renew";
  return new NextRequest(url, { method: "GET" });
}

function makePost(body: unknown) {
  return new NextRequest("https://example.com/api/domains/renew", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const user = {
  _id: "U1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Smith",
};

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  getRenewalPricing.mockReset();
  getDomainExpiry.mockReset();
  rcRenewDomain.mockReset();
  createOrder.mockReset().mockImplementation(async (data) => data);
  appendUserDomain.mockReset().mockResolvedValue(undefined);
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET — auth gate", () => {
  it("no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeGet("domainName=x.com&years=1"));
    expect(res.status).toBe(401);
    expect(getRenewalPricing).not.toHaveBeenCalled();
  });
});

describe("GET — zod query schema", () => {
  it("missing domainName → 400", async () => {
    const res = await GET(makeGet(""));
    expect(res.status).toBe(400);
  });

  it("domain < 3 chars → 400", async () => {
    const res = await GET(makeGet("domainName=ab"));
    expect(res.status).toBe(400);
  });

  it("years > 10 → 400", async () => {
    const res = await GET(makeGet("domainName=x.com&years=11"));
    expect(res.status).toBe(400);
  });

  it("years missing → defaults to 1", async () => {
    getRenewalPricing.mockResolvedValueOnce({
      status: "success",
      data: { price: 999 },
    });
    getDomainExpiry.mockResolvedValueOnce({ status: "success", data: {} });
    const res = await GET(makeGet("domainName=x.com"));
    expect(res.status).toBe(200);
    expect(getRenewalPricing).toHaveBeenCalledWith("x.com", 1);
  });

  it("years coerced from string → int (z.coerce)", async () => {
    getRenewalPricing.mockResolvedValueOnce({
      status: "success",
      data: { price: 999 },
    });
    getDomainExpiry.mockResolvedValueOnce({ status: "success", data: {} });
    await GET(makeGet("domainName=x.com&years=3"));
    expect(getRenewalPricing).toHaveBeenCalledWith("x.com", 3);
  });

  it("domain trim+lower applied before lookup", async () => {
    getRenewalPricing.mockResolvedValueOnce({
      status: "success",
      data: { price: 999 },
    });
    getDomainExpiry.mockResolvedValueOnce({ status: "success", data: {} });
    await GET(makeGet("domainName=%20ExAmPle.COM%20&years=1"));
    expect(getRenewalPricing).toHaveBeenCalledWith("example.com", 1);
  });
});

describe("GET — pricing error", () => {
  it("getRenewalPricing status=error → 500 with the RC message", async () => {
    getRenewalPricing.mockResolvedValueOnce({
      status: "error",
      message: "Domain not in your reseller account",
    });
    const res = await GET(makeGet("domainName=x.com&years=1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Domain not in your reseller account");
    expect(getDomainExpiry).not.toHaveBeenCalled();
  });
});

describe("GET — happy path", () => {
  it("pricing + expiry → 200 with both", async () => {
    getRenewalPricing.mockResolvedValueOnce({
      status: "success",
      data: { price: 999, currency: "INR" },
    });
    getDomainExpiry.mockResolvedValueOnce({
      status: "success",
      data: { expiryDate: "2027-06-01" },
    });
    const res = await GET(makeGet("domainName=x.com&years=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        domainName: "x.com",
        years: 2,
        pricing: { price: 999, currency: "INR" },
        expiry: { expiryDate: "2027-06-01" },
      })
    );
  });
});

// ─────────────────────────── POST ─────────────────────────────

describe("POST — auth gate", () => {
  it("no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makePost({ domainName: "x.com", years: 1, paymentId: "pay_123" })
    );
    expect(res.status).toBe(401);
    expect(rcRenewDomain).not.toHaveBeenCalled();
  });
});

describe("POST — zod body schema", () => {
  it("missing paymentId → 400", async () => {
    const res = await POST(
      makePost({ domainName: "x.com", years: 1 })
    );
    expect(res.status).toBe(400);
    expect(rcRenewDomain).not.toHaveBeenCalled();
  });

  it("years=0 → 400 (positive)", async () => {
    const res = await POST(
      makePost({ domainName: "x.com", years: 0, paymentId: "p" })
    );
    expect(res.status).toBe(400);
  });

  it("years=-1 → 400 (positive)", async () => {
    const res = await POST(
      makePost({ domainName: "x.com", years: -1, paymentId: "p" })
    );
    expect(res.status).toBe(400);
  });

  it("years=1.5 (float) → 400 (int)", async () => {
    const res = await POST(
      makePost({ domainName: "x.com", years: 1.5, paymentId: "p" })
    );
    expect(res.status).toBe(400);
  });

  it("years > 10 → 400", async () => {
    const res = await POST(
      makePost({ domainName: "x.com", years: 11, paymentId: "p" })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST — RC 3-branch outcome dispatch", () => {
  const VALID = {
    domainName: "x.com",
    years: 2,
    paymentId: "pay_abc",
  };

  it("renewed → 200 + createOrder + appendUserDomain + new-expiry math", async () => {
    rcRenewDomain.mockResolvedValueOnce({
      kind: "renewed",
      orderId: "ENT-789",
      price: 1500,
    });
    const before = Date.now();
    const res = await POST(makePost(VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.domainName).toBe("x.com");
    expect(body.years).toBe(2);

    // createOrder shape
    expect(createOrder).toHaveBeenCalledTimes(1);
    const orderArg = createOrder.mock.calls[0][0];
    expect(orderArg).toEqual(
      expect.objectContaining({
        userId: "U1",
        userEmail: "alice@example.com",
        userName: "Alice Smith",
        paymentId: "pay_abc",
        amount: 1500,
        currency: "INR",
        status: "completed",
        successfulDomains: ["x.com"],
      })
    );
    expect(orderArg.orderId).toMatch(/^RENEW_/);
    expect(orderArg.domains).toHaveLength(1);
    expect(orderArg.domains[0]).toEqual(
      expect.objectContaining({
        domainName: "x.com",
        price: 1500,
        currency: "INR",
        registrationPeriod: 2,
        status: "registered",
        orderId: "ENT-789",
      })
    );

    // appendUserDomain mirrors
    expect(appendUserDomain).toHaveBeenCalledWith(
      "U1",
      expect.objectContaining({
        domainName: "x.com",
        price: 1500,
        registrationPeriod: 2,
        orderId: "ENT-789",
        status: "registered",
      })
    );

    // new-expiry math: ~2 × 365 days from now
    const newExpiry = new Date(body.newExpiryDate).getTime();
    const expected = before + 2 * 365 * 24 * 60 * 60 * 1000;
    expect(newExpiry).toBeGreaterThanOrEqual(expected - 5000);
    expect(newExpiry).toBeLessThanOrEqual(expected + 5000);
  });

  it("renewed with price absent → uses 0 (defensive)", async () => {
    rcRenewDomain.mockResolvedValueOnce({
      kind: "renewed",
      orderId: "ENT-1",
      // no price
    });
    await POST(makePost(VALID));
    const orderArg = createOrder.mock.calls[0][0];
    expect(orderArg.amount).toBe(0);
    expect(orderArg.domains[0].price).toBe(0);
  });

  it("balance_pending → 202 + queued message; NO createOrder; NO appendUserDomain", async () => {
    rcRenewDomain.mockResolvedValueOnce({ kind: "balance_pending" });
    const res = await POST(makePost(VALID));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.error.toLowerCase()).toContain("queued");
    expect(createOrder).not.toHaveBeenCalled();
    expect(appendUserDomain).not.toHaveBeenCalled();
  });

  it("hard_failure → 500 + generic; NO createOrder; NO appendUserDomain; sentinel NOT leaked", async () => {
    rcRenewDomain.mockResolvedValueOnce({ kind: "hard_failure" });
    const res = await POST(makePost(VALID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain("team");
    expect(createOrder).not.toHaveBeenCalled();
    expect(appendUserDomain).not.toHaveBeenCalled();
  });
});

describe("POST — userName template-literal", () => {
  const VALID = {
    domainName: "x.com",
    years: 1,
    paymentId: "p",
  };

  it("Both names present → 'Alice Smith'", async () => {
    rcRenewDomain.mockResolvedValueOnce({
      kind: "renewed",
      orderId: "E1",
      price: 100,
    });
    await POST(makePost(VALID));
    expect(createOrder.mock.calls[0][0].userName).toBe("Alice Smith");
  });

  it("Missing names → empty-string-trimmed userName='' (NOT 'undefined undefined' — the route uses `|| ''` short-circuit, not just template)", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U1",
      email: "x@y.com",
      // no firstName/lastName
    });
    rcRenewDomain.mockResolvedValueOnce({
      kind: "renewed",
      orderId: "E1",
      price: 100,
    });
    await POST(makePost(VALID));
    // The route writes `${firstName || ''} ${lastName || ''}`.trim() →
    // " ".trim() → "". Pinned (better than the test-plan quirk).
    expect(createOrder.mock.calls[0][0].userName).toBe("");
  });
});

describe("POST — outer catch", () => {
  it("rcRenewDomain throw → 500 generic; sentinel NOT leaked", async () => {
    rcRenewDomain.mockRejectedValueOnce(
      new Error("RC SDK crash — rc_secret_LEAK_ME")
    );
    const res = await POST(
      makePost({ domainName: "x.com", years: 1, paymentId: "p" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to renew domain");
    expect(JSON.stringify(body)).not.toContain("rc_secret_LEAK_ME");
  });
});
