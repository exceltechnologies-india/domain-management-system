/**
 * Tests for `app/api/domains/renew/route.ts` (slice 7hw, part 2).
 *
 * Customer-initiated domain renewal: GET fetches renewal pricing +
 * expiry; POST executes the renewal after payment confirmation.
 *
 * Threat model:
 *  - **IDOR / renewing somebody else's domain**: POST spends the
 *    reseller's balance at the registrar. Until 2026-09-21 it checked
 *    only that the caller was signed in, so any customer could renew
 *    any domain in the account. Pinned: a domain not on one of the
 *    caller's own orders must 404 and must NOT reach rcRenewDomain.
 *    404 (not 403) is deliberate — findOrderByDomainForUser's docstring
 *    makes "not yours" and "not there" indistinguishable. GET carries
 *    the same gate: it answers expiry, and forwards ResellerClub's
 *    "Domain not in your reseller account" verbatim.
 *  - **Renewal without payment**: the body used to take a free-text
 *    `paymentId` nothing verified, and the only caller fabricated one,
 *    so every renewal was free. Pinned: verifyRazorpayPayment must run
 *    BEFORE rcRenewDomain, and its refusal must stop the spend.
 *  - **Replayed payment**: one captured payment must fund one order.
 *    Pinned: a payment id already on an order → 409, no registrar call.
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
 *  - POST zod body: both Razorpay ids required (≥1 char); signature
 *    optional (the Tokens/mandate flow returns none — see
 *    lib/services/payment/verification.ts)
 *  - createOrder passes razorpayOrderId + razorpayPaymentId, which the
 *    Order schema marks required. Omitting them threw a ValidationError
 *    into the catch on EVERY run, after the registrar had been charged.
 *    Pinned, because the mocked orders service cannot see it.
 *  - GET pricing error → 500 with the RC message
 *  - POST 3-branch outcome dispatch:
 *      renewed → 200 + createOrder + appendUserDomain + new-expiry-date
 *      balance_pending → 202 + queued message + NO writes
 *      hard_failure → split by TRANSPORT: 502 "safe to try again" when the
 *        registrar answered or was never reached, 409 "do NOT try again" when
 *        the request may have landed. Both still write nothing.
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
const findOrderByDomainForUser = vi.hoisted(() => vi.fn());
const findOrderDomain = vi.hoisted(() => vi.fn());
const getOrderByRazorpayPaymentId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  createOrder,
  findOrderByDomainForUser,
  findOrderDomain,
  getOrderByRazorpayPaymentId,
}));

const verifyRazorpayPayment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/verification", () => ({
  verifyRazorpayPayment,
}));

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

/** The Razorpay half of a valid body. Spread into POST payloads. */
const PAID = {
  razorpay_order_id: "order_RZP1",
  razorpay_payment_id: "pay_RZP1",
  razorpay_signature: "sig_RZP1",
};

/** An order of the caller's that contains the domain under test. */
const ownedOrder = { orderId: "ORD-1", domains: [{ domainName: "x.com" }] };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  getRenewalPricing.mockReset();
  getDomainExpiry.mockReset();
  rcRenewDomain.mockReset();
  createOrder.mockReset().mockImplementation(async (data) => data);
  appendUserDomain.mockReset().mockResolvedValue(undefined);
  // Default: the caller owns the domain, the payment is good, and it has
  // not been spent. Each gate's own describe block overrides one of these,
  // so a test that fails does so for exactly one stated reason.
  findOrderByDomainForUser.mockReset().mockResolvedValue(ownedOrder);
  findOrderDomain.mockReset().mockReturnValue({ domainName: "x.com" });
  getOrderByRazorpayPaymentId.mockReset().mockResolvedValue(null);
  verifyRazorpayPayment
    .mockReset()
    .mockResolvedValue({ ok: true, paymentDetails: { status: "captured" } });
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

describe("GET — ownership gate", () => {
  it("domain not on one of the caller's orders → 404, no RC lookup", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await GET(makeGet("domainName=x.com&years=1"));
    expect(res.status).toBe(404);
    // Without this, GET answers "when does this domain expire" and forwards
    // RC's "Domain not in your reseller account" for any domain asked about.
    expect(getRenewalPricing).not.toHaveBeenCalled();
    expect(getDomainExpiry).not.toHaveBeenCalled();
  });

  it("scoped to the caller", async () => {
    getRenewalPricing.mockResolvedValueOnce({ status: "success", data: {} });
    getDomainExpiry.mockResolvedValueOnce({ status: "success", data: {} });
    await GET(makeGet("domainName=x.com&years=1"));
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U1", "x.com");
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
      makePost({ domainName: "x.com", years: 1, ...PAID })
    );
    expect(res.status).toBe(401);
    expect(rcRenewDomain).not.toHaveBeenCalled();
  });
});

describe("POST — zod body schema", () => {
  it("no payment fields at all → 400, nothing spent", async () => {
    // This is the old body shape — `{domainName, years, paymentId}` — which
    // is what the modal sent with its fabricated id. It must no longer be
    // accepted by anything.
    const res = await POST(
      makePost({ domainName: "x.com", years: 1, paymentId: "renew_123_abc" })
    );
    expect(res.status).toBe(400);
    expect(rcRenewDomain).not.toHaveBeenCalled();
  });

  it("razorpay_order_id missing → 400", async () => {
    const res = await POST(
      makePost({
        domainName: "x.com",
        years: 1,
        razorpay_payment_id: "pay_RZP1",
      })
    );
    expect(res.status).toBe(400);
    expect(rcRenewDomain).not.toHaveBeenCalled();
  });

  it("razorpay_payment_id missing → 400", async () => {
    const res = await POST(
      makePost({
        domainName: "x.com",
        years: 1,
        razorpay_order_id: "order_RZP1",
      })
    );
    expect(res.status).toBe(400);
    expect(rcRenewDomain).not.toHaveBeenCalled();
  });

  it("signature absent → allowed (Tokens/mandate flow returns none)", async () => {
    rcRenewDomain.mockResolvedValueOnce({
      kind: "renewed",
      orderId: "E1",
      price: 100,
    });
    const res = await POST(
      makePost({
        domainName: "x.com",
        years: 1,
        razorpay_order_id: "order_RZP1",
        razorpay_payment_id: "pay_RZP1",
      })
    );
    expect(res.status).toBe(200);
    // ...and the absent signature is stored as "" rather than undefined,
    // which is what the Order schema's default expects.
    expect(createOrder.mock.calls[0][0].razorpaySignature).toBe("");
  });

  it("years=0 → 400 (positive)", async () => {
    const res = await POST(
      makePost({ domainName: "x.com", years: 0, ...PAID })
    );
    expect(res.status).toBe(400);
  });

  it("years=-1 → 400 (positive)", async () => {
    const res = await POST(
      makePost({ domainName: "x.com", years: -1, ...PAID })
    );
    expect(res.status).toBe(400);
  });

  it("years=1.5 (float) → 400 (int)", async () => {
    const res = await POST(
      makePost({ domainName: "x.com", years: 1.5, ...PAID })
    );
    expect(res.status).toBe(400);
  });

  it("years > 10 → 400", async () => {
    const res = await POST(
      makePost({ domainName: "x.com", years: 11, ...PAID })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST — ownership gate (IDOR)", () => {
  const BODY = { domainName: "x.com", years: 1, ...PAID };

  it("domain on nobody's order for this user → 404, registrar NOT called", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(404);
    // The whole point: no money leaves before this gate.
    expect(rcRenewDomain).not.toHaveBeenCalled();
    expect(verifyRazorpayPayment).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("order found but the domain is not in it → 404, registrar NOT called", async () => {
    // findOrderByDomainForUser matches on "domains.domainName", so a hit
    // means the array contains it — but the second lookup is the one that
    // returns the subdoc, and a mismatch there must not fall through.
    findOrderDomain.mockReturnValueOnce(undefined);
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(404);
    expect(rcRenewDomain).not.toHaveBeenCalled();
  });

  it("the ownership query is scoped to the CALLER, not just the domain", async () => {
    rcRenewDomain.mockResolvedValueOnce({ kind: "renewed", orderId: "E1", price: 1 });
    await POST(makePost(BODY));
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U1", "x.com");
  });

  it("404 copy does not confirm the domain exists", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await POST(makePost(BODY));
    const body = await res.json();
    // "not on your account" — never "belongs to another customer", which
    // would turn this endpoint into a lookup for who owns what.
    expect(body.error).toMatch(/could not find that domain on your account/i);
    expect(body.error).not.toMatch(/another|other customer|owned by/i);
  });
});

describe("POST — payment gate", () => {
  const BODY = { domainName: "x.com", years: 1, ...PAID };

  it("verification refused → its response is returned, registrar NOT called", async () => {
    verifyRazorpayPayment.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Invalid signature" }, { status: 400 }),
    });
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid signature" });
    expect(rcRenewDomain).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("the claimed ids are what get verified", async () => {
    rcRenewDomain.mockResolvedValueOnce({ kind: "renewed", orderId: "E1", price: 1 });
    await POST(makePost(BODY));
    expect(verifyRazorpayPayment).toHaveBeenCalledWith({
      razorpay_order_id: "order_RZP1",
      razorpay_payment_id: "pay_RZP1",
      razorpay_signature: "sig_RZP1",
    });
  });

  it("payment already on an order → 409, registrar NOT called", async () => {
    getOrderByRazorpayPaymentId.mockResolvedValueOnce({ orderId: "ORD-EARLIER" });
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(409);
    // A replay must not renew a second time on one charge.
    expect(rcRenewDomain).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("replay check keys on razorpayPaymentId, not the legacy paymentId", async () => {
    rcRenewDomain.mockResolvedValueOnce({ kind: "renewed", orderId: "E1", price: 1 });
    await POST(makePost(BODY));
    expect(getOrderByRazorpayPaymentId).toHaveBeenCalledWith("pay_RZP1");
  });
});

describe("POST — gate ORDER (both run before the registrar)", () => {
  it("ownership is checked before payment is verified", async () => {
    // Not cosmetic: verifying a payment for a domain you do not own would
    // charge the customer for a renewal the route then refuses.
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    await POST(makePost({ domainName: "x.com", years: 1, ...PAID }));
    expect(verifyRazorpayPayment).not.toHaveBeenCalled();
  });

  it("every gate precedes rcRenewDomain on the happy path", async () => {
    const order: string[] = [];
    findOrderByDomainForUser.mockImplementationOnce(async () => {
      order.push("own");
      return ownedOrder;
    });
    verifyRazorpayPayment.mockImplementationOnce(async () => {
      order.push("pay");
      return { ok: true, paymentDetails: { status: "captured" } };
    });
    getOrderByRazorpayPaymentId.mockImplementationOnce(async () => {
      order.push("replay");
      return null;
    });
    rcRenewDomain.mockImplementationOnce(async () => {
      order.push("spend");
      return { kind: "renewed", orderId: "E1", price: 1 };
    });
    await POST(makePost({ domainName: "x.com", years: 1, ...PAID }));
    expect(order).toEqual(["own", "pay", "replay", "spend"]);
  });
});

describe("POST — RC 3-branch outcome dispatch", () => {
  const VALID = {
    domainName: "x.com",
    years: 2,
    ...PAID,
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
        razorpayOrderId: "order_RZP1",
        razorpayPaymentId: "pay_RZP1",
        razorpaySignature: "sig_RZP1",
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

  /**
   * hard_failure used to be one branch returning 500. It is now split by
   * TRANSPORT, and the split is the point: 500 is the status clients, proxies
   * and impatient customers retry, so the one case that must never be repeated
   * was the one advertised as repeatable. A renewal is not known to be
   * idempotent (Todos.md §E).
   *
   * What the old assertion guarded — no createOrder, no appendUserDomain on a
   * failed renewal — is asserted in BOTH branches below, because that guarantee
   * did not change and is the more important half.
   */
  it.each([
    ["responded", "the registrar answered no"],
    ["not_sent", "the request never left"],
  ])("hard_failure/%s → 502 and says a retry is safe; NO writes", async (transport) => {
    rcRenewDomain.mockResolvedValueOnce({ kind: "hard_failure", reason: "x", transport });
    const res = await POST(makePost(VALID));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain("safe to try again");
    expect(body.status).toBe("not_renewed");
    expect(createOrder).not.toHaveBeenCalled();
    expect(appendUserDomain).not.toHaveBeenCalled();
  });

  it("hard_failure/sent_unknown → 409, tells them NOT to retry; NO writes", async () => {
    // The whole reason the transport field exists. The renewal may already
    // have happened, so the customer must not be invited to buy a second year
    // — by the copy or by the status code.
    rcRenewDomain.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "socket hang up",
      transport: "sent_unknown",
    });
    const res = await POST(makePost(VALID));
    expect(res.status).toBe(409);
    expect(res.status).not.toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/do NOT try again/);
    expect(body.error).toMatch(/extra year/i);
    expect(body.status).toBe("unconfirmed");
    expect(createOrder).not.toHaveBeenCalled();
    expect(appendUserDomain).not.toHaveBeenCalled();
  });
});

/**
 * Past the registrar call the money is spent and the domain is renewed. A
 * failure in OUR bookkeeping after that point must not be reported as a failed
 * renewal — the customer reads it, presses renew again, and buys a second year.
 * This route's own history is a ValidationError thrown in exactly this spot on
 * every run, after the registrar had been charged.
 */
describe("POST — a bookkeeping failure AFTER a successful renewal", () => {
  const VALID = { domainName: "x.com", years: 1, ...PAID };

  it("reports the renewal as DONE, flags the record, and does not invite a retry", async () => {
    rcRenewDomain.mockResolvedValueOnce({
      kind: "renewed",
      orderId: "RC-1",
      price: 900,
    });
    createOrder.mockRejectedValueOnce(new Error("ValidationError: razorpayOrderId required"));

    const res = await POST(makePost(VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.recorded).toBe(false);
    expect(body.message).toMatch(/has been renewed/i);
    expect(body.message).toMatch(/no need to renew again/i);
  });

  it("a successful run says so, and carries the order id", async () => {
    // The control for the test above: without it, a route that always returned
    // recorded:false would pass and prove nothing.
    rcRenewDomain.mockResolvedValueOnce({
      kind: "renewed",
      orderId: "RC-1",
      price: 900,
    });
    const res = await POST(makePost(VALID));
    const body = await res.json();
    expect(body.recorded).toBe(true);
    expect(body.orderId).toBeTruthy();
  });
});

describe("POST — userName template-literal", () => {
  const VALID = {
    domainName: "x.com",
    years: 1,
    ...PAID,
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
      makePost({ domainName: "x.com", years: 1, ...PAID })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to renew domain");
    expect(JSON.stringify(body)).not.toContain("rc_secret_LEAK_ME");
  });
});
