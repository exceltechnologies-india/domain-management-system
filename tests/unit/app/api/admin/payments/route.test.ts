/**
 * Tests for `app/api/admin/payments/route.ts` (slice 7i5, part 1).
 *
 * Admin payments dashboard — pulls Razorpay payments, joins with
 * local orders + user records, returns paginated enriched list.
 *
 * Threat model:
 *  - **Non-admin payment-data leak**: payment-method strings, refund
 *    metadata, and customer emails are visible to anyone with the
 *    URL otherwise. Pinned: admin gate before any Razorpay call.
 *  - **Cross-customer name swap via stale order link**: if the
 *    Razorpay payment lacks a local order match, the route must
 *    fall back to looking up the user by email — NOT just leave
 *    the name blank or guess. Pinned with a 3-step chain.
 *
 * Other pins:
 *  - admin gate → 401
 *  - date-range branch: ?from + ?to → getPaymentsByDateRange;
 *    else getAllPayments
 *  - fetchLimit = Math.max(limit*5, 25); fetchSkip=0
 *  - filterDomainPayments narrows to domain-related payments
 *  - amount conversion: paise (1000) → rupees (10.00)
 *  - currency upper-cased
 *  - customer name chain:
 *      (1) orderData.userId → 'First Last' from populated user
 *      (2) paymentDetails.customerName fallback
 *      (3) findUsersByEmails lookup by razorpayPayment.email
 *      (4) 'Unknown' if all 3 fail
 *  - createdAt: Razorpay seconds → ISO; missing → now
 *  - refunded boolean from amount_refunded > 0
 *  - sort by createdAt desc (newest first)
 *  - pagination slice; hasMore math
 *  - outer catch → 500 generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getAllPayments = vi.hoisted(() => vi.fn());
const getPaymentsByDateRange = vi.hoisted(() => vi.fn());
const filterDomainPayments = vi.hoisted(() => vi.fn());
const getDomainPaymentDetails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay-payments", () => ({
  RazorpayPaymentsService: {
    getAllPayments,
    getPaymentsByDateRange,
    filterDomainPayments,
    getDomainPaymentDetails,
  },
}));

const listOrdersByRazorpayPaymentIds = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  listOrdersByRazorpayPaymentIds,
}));

const findUsersByEmails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ findUsersByEmails }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/payments/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/admin/payments?${qs}`
    : "https://example.com/api/admin/payments";
  return new NextRequest(url, { method: "GET" });
}

function makeRzpPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_abc",
    amount: 99900, // 999.00 in paise
    currency: "inr",
    status: "captured",
    method: "card",
    email: "alice@example.com",
    created_at: 1718000000,
    updated_at: 1718000010,
    captured: true,
    amount_refunded: 0,
    fee: 1000, // 10 in paise
    tax: 100, // 1 in paise
    notes: {},
    ...overrides,
  };
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({ _id: "ADMIN1" });
  getAllPayments.mockReset();
  getPaymentsByDateRange.mockReset();
  filterDomainPayments.mockReset().mockImplementation((items) => items);
  getDomainPaymentDetails.mockReset().mockResolvedValue({});
  listOrdersByRazorpayPaymentIds.mockReset().mockResolvedValue([]);
  findUsersByEmails.mockReset().mockResolvedValue([]);
});

describe("Admin gate", () => {
  it("non-admin → 401; no Razorpay call", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(getAllPayments).not.toHaveBeenCalled();
  });
});

describe("Date-range branch", () => {
  beforeEach(() => {
    getAllPayments.mockResolvedValue({ items: [], count: 0 });
    getPaymentsByDateRange.mockResolvedValue({ items: [], count: 0 });
  });

  it("no ?from/?to → getAllPayments called", async () => {
    await GET(makeReq("limit=5"));
    expect(getAllPayments).toHaveBeenCalledTimes(1);
    expect(getPaymentsByDateRange).not.toHaveBeenCalled();
  });

  it("?from + ?to → getPaymentsByDateRange called with parsed Date objects", async () => {
    await GET(makeReq("from=2026-01-01&to=2026-06-01"));
    expect(getPaymentsByDateRange).toHaveBeenCalledTimes(1);
    expect(getAllPayments).not.toHaveBeenCalled();
    const [fromArg, toArg] = getPaymentsByDateRange.mock.calls[0];
    expect(fromArg).toBeInstanceOf(Date);
    expect(toArg).toBeInstanceOf(Date);
  });

  it("**fetchLimit = max(limit*5, 25)**", async () => {
    await GET(makeReq("limit=10"));
    expect(getAllPayments).toHaveBeenCalledWith(50, 0);

    getAllPayments.mockClear();
    await GET(makeReq("limit=1"));
    // 1*5 = 5 < 25, so min floor is 25
    expect(getAllPayments).toHaveBeenCalledWith(25, 0);
  });

  it("default limit=5, fetchLimit=25", async () => {
    await GET(makeReq());
    expect(getAllPayments).toHaveBeenCalledWith(25, 0);
  });
});

describe("Customer name 3-step chain", () => {
  function setupOne(rzp: Record<string, unknown>, opts: {
    orderData?: Record<string, unknown> | undefined;
    paymentDetails?: Record<string, unknown> | undefined;
    userByEmail?: Record<string, unknown> | undefined;
  }) {
    getAllPayments.mockResolvedValueOnce({ items: [rzp], count: 1 });
    if (opts.orderData) {
      listOrdersByRazorpayPaymentIds.mockResolvedValueOnce([opts.orderData]);
    }
    if (opts.paymentDetails) {
      getDomainPaymentDetails.mockResolvedValueOnce(opts.paymentDetails);
    }
    if (opts.userByEmail) {
      findUsersByEmails.mockResolvedValueOnce([opts.userByEmail]);
    }
  }

  it("(1) orderData.userId populated → name from order user", async () => {
    setupOne(makeRzpPayment(), {
      orderData: {
        razorpayPaymentId: "pay_abc",
        userId: { firstName: "Alice", lastName: "Smith", email: "alice@example.com" },
      },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].customerName).toBe("Alice Smith");
  });

  it("(2) No orderData → paymentDetails.customerName fallback", async () => {
    setupOne(makeRzpPayment(), {
      paymentDetails: { customerName: "Bob From Razorpay" },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].customerName).toBe("Bob From Razorpay");
  });

  it("(3) No orderData + no paymentDetails name → findUsersByEmails fallback", async () => {
    setupOne(makeRzpPayment(), {
      paymentDetails: {},
      userByEmail: {
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Smith",
      },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].customerName).toBe("Alice Smith");
  });

  it("(4) No match anywhere → empty name (UI renders email + 'No linked account', not 'Unknown')", async () => {
    setupOne(makeRzpPayment(), { paymentDetails: {} });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].customerName).toBe("");
  });
});

describe("Amount + currency + refund math", () => {
  beforeEach(() => {
    listOrdersByRazorpayPaymentIds.mockResolvedValue([]);
    getDomainPaymentDetails.mockResolvedValue({});
  });

  it("amount paise→rupees: 99900 → 999", async () => {
    getAllPayments.mockResolvedValueOnce({
      items: [makeRzpPayment({ amount: 99900 })],
      count: 1,
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].amount).toBe(999);
  });

  it("currency upper-cased: 'inr' → 'INR'", async () => {
    getAllPayments.mockResolvedValueOnce({
      items: [makeRzpPayment({ currency: "inr" })],
      count: 1,
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].currency).toBe("INR");
  });

  it("refund: amount_refunded > 0 → refunded=true + amount in rupees", async () => {
    getAllPayments.mockResolvedValueOnce({
      items: [
        makeRzpPayment({ amount_refunded: 50000, refund_status: "processed" }),
      ],
      count: 1,
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].refunded).toBe(true);
    expect(body.payments[0].refundAmount).toBe(500);
    expect(body.payments[0].refundStatus).toBe("processed");
  });

  it("refund=0 → refunded=false", async () => {
    getAllPayments.mockResolvedValueOnce({
      items: [makeRzpPayment()],
      count: 1,
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].refunded).toBe(false);
  });

  it("fee/tax conversion: paise → rupees", async () => {
    getAllPayments.mockResolvedValueOnce({
      items: [makeRzpPayment({ fee: 1000, tax: 100 })],
      count: 1,
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].fee).toBe(10);
    expect(body.payments[0].tax).toBe(1);
  });

  it("missing fee/tax → 0", async () => {
    getAllPayments.mockResolvedValueOnce({
      items: [makeRzpPayment({ fee: undefined, tax: undefined })],
      count: 1,
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].fee).toBe(0);
    expect(body.payments[0].tax).toBe(0);
  });
});

describe("Timestamps", () => {
  beforeEach(() => {
    listOrdersByRazorpayPaymentIds.mockResolvedValue([]);
    getDomainPaymentDetails.mockResolvedValue({});
  });

  it("Razorpay seconds → ISO string", async () => {
    getAllPayments.mockResolvedValueOnce({
      items: [makeRzpPayment({ created_at: 1718000000 })],
      count: 1,
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].createdAt).toBe(
      new Date(1718000000 * 1000).toISOString()
    );
  });

  it("captured + updated_at → processedAt populated", async () => {
    getAllPayments.mockResolvedValueOnce({
      items: [
        makeRzpPayment({ captured: true, updated_at: 1718000050 }),
      ],
      count: 1,
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].processedAt).toBe(
      new Date(1718000050 * 1000).toISOString()
    );
  });

  it("not captured → processedAt undefined", async () => {
    getAllPayments.mockResolvedValueOnce({
      items: [makeRzpPayment({ captured: false })],
      count: 1,
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.payments[0].processedAt).toBeUndefined();
  });
});

describe("Sort + pagination", () => {
  beforeEach(() => {
    listOrdersByRazorpayPaymentIds.mockResolvedValue([]);
    getDomainPaymentDetails.mockResolvedValue({});
  });

  it("sorts createdAt desc — newest first", async () => {
    getAllPayments.mockResolvedValueOnce({
      items: [
        makeRzpPayment({ id: "pay_old", created_at: 1717000000 }),
        makeRzpPayment({ id: "pay_new", created_at: 1719000000 }),
      ],
      count: 2,
    });
    const res = await GET(makeReq("limit=10"));
    const body = await res.json();
    expect(body.payments[0].id).toBe("pay_new");
    expect(body.payments[1].id).toBe("pay_old");
  });

  it("limit=5 + 10 items → returns 5, hasMore=true", async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeRzpPayment({
        id: `pay_${i}`,
        created_at: 1718000000 + i,
      })
    );
    getAllPayments.mockResolvedValueOnce({ items, count: 10 });
    const res = await GET(makeReq("limit=5"));
    const body = await res.json();
    expect(body.payments).toHaveLength(5);
    expect(body.hasMore).toBe(true);
  });

  it("limit=20 + 10 items → returns 10, hasMore=false", async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeRzpPayment({ id: `pay_${i}`, created_at: 1718000000 + i })
    );
    getAllPayments.mockResolvedValueOnce({ items, count: 10 });
    const res = await GET(makeReq("limit=20"));
    const body = await res.json();
    expect(body.payments).toHaveLength(10);
    expect(body.hasMore).toBe(false);
  });
});

describe("Outer catch", () => {
  it("Razorpay throw → 500 generic; sentinel NOT leaked", async () => {
    getAllPayments.mockRejectedValueOnce(
      new Error("Razorpay 5xx — rzp_secret_LEAK_ME")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch payments");
    expect(JSON.stringify(body)).not.toContain("rzp_secret_LEAK_ME");
  });
});
