/**
 * Tests for `@/lib/services/payment/renewal` (rescan-4 slice 7fg).
 * handleRenewalPayment — invoked from /verify when the order looks
 * like a renewal. Pins:
 *  - **isRenewal detection**: 3 signals — razorpay_order_id starts
 *    with `ord_renew_` OR `rnw_` OR paymentDetails.notes.type ===
 *    'invoice_payment'; none → returns null (fall through to normal
 *    new-order flow)
 *  - Order lookup tries Razorpay-id FIRST then internal-orderId
 *    fallback (verify route may pass either)
 *  - **Invoice creation branch** (no existing invoiceId): builds
 *    cartItems from renewalOrder.domains with periodUnit defaulting
 *    to 'months' for hosting / 'years' for domain, and delegates to
 *    `createPrimaryInvoice` (Primary Billing Integration Phase 1c-2) —
 *    the chokepoint that tries the primary GST engine first and falls
 *    back to Zoho on failure. This is the SAME chokepoint
 *    `/api/payments/verify` uses; its own decision logic is covered by
 *    tests/unit/lib/services/billing/createPrimaryInvoice.test.ts, so
 *    this suite only pins that renewal.ts calls it with the right
 *    context and reacts correctly to its result. A throw is SWALLOWED
 *    (renewal still proceeds — payment captured).
 *  - **Existing invoiceId branch** (notes.invoice_id present): applies
 *    payment to the existing invoice via applyPaymentToInvoice (still
 *    Zoho-direct — no primary-engine equivalent for "pay an existing
 *    pre-issued invoice" yet); amount converted from paise to rupees
 *    via Math.round/100
 *  - **Hosting reactivation pre-fetches ALL user hostings once** + maps
 *    by domainName (O(N+M) instead of N round-trips per item)
 *  - daUnsuspendUser only called when status is 'expired' OR 'suspended'
 *    + directAdminUsername is present
 *  - **expiry extension base**: if current expiryDate is in the future,
 *    extend from THAT date (stack, not now); else from now (renewal of
 *    an already-lapsed account)
 *  - **periodUnit dispatch**: minutes / days / years use the matching
 *    setX method; default (months) uses setUTCMonth (UTC-stable across
 *    DST boundaries)
 *  - hosting.renewalInvoiceId + renewalStatus:'paid' written via cast
 *    (typed shape doesn't include them; ops dashboards read them);
 *    next_action_at = newExpiry - 15 days
 *  - **No order → broad fallback reactivation**: walks user hostings,
 *    unsuspends + extends 1 month for any suspended/expired ones (safety
 *    net for legacy renewal flows where order wasn't created)
 *  - Reactivation throw SWALLOWED (logged + still returns 200 — payment
 *    captured, can be reconciled)
 *  - Order completion: status:'completed' + razorpayPaymentId stamped +
 *    each domain.status flipped to 'registered'; save throw SWALLOWED
 *  - Always returns 200 'Payment verified, services reactivated' once
 *    detected as renewal (renewal flow never returns an error to the
 *    client — payment IS captured by the time we get here)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getOrderByRazorpayOrderId = vi.hoisted(() => vi.fn());
const getOrderByOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  getOrderByRazorpayOrderId,
  getOrderByOrderId,
}));

const listHostingsForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ listHostingsForUser }));

// applyPaymentToInvoice stays Zoho-direct — renewal.ts's "pay an existing
// pre-issued invoice" branch has no primary-engine equivalent yet.
const applyPaymentToInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: {
    getInstance: () => ({ applyPaymentToInvoice }),
  },
}));

// createPrimaryInvoice is the chokepoint renewal.ts now calls for the
// create-a-new-invoice branch (Phase 1c-2). Its own decision logic (flag
// check, zero-amount skip, fallback-to-Zoho) is covered by
// createPrimaryInvoice.test.ts — this suite just pins that renewal.ts calls
// it correctly and reacts correctly to {invoiceId, invoiceNumber}.
const createPrimaryInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/billing/createPrimaryInvoice", () => ({
  createPrimaryInvoice,
}));

const daUnsuspendUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  unsuspendUser: daUnsuspendUser,
}));

vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { NAMESERVERS: ["ns1.test", "ns2.test"] },
  DA_SERVER_IP: "10.0.0.1",
}));

const sendHostingProvisionedEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendHostingProvisionedEmail },
}));

const getCurrentDate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dateUtils", () => ({ getCurrentDate }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.unmock("next/server");
const { NextResponse } = await vi.importActual<typeof import("next/server")>(
  "next/server"
);
vi.doMock("next/server", () => ({ NextResponse }));

import { handleRenewalPayment } from "@/lib/services/payment/renewal";

const NOW = new Date("2026-06-01T00:00:00Z");

beforeEach(() => {
  getOrderByRazorpayOrderId.mockReset();
  getOrderByOrderId.mockReset();
  listHostingsForUser.mockReset();
  // Default: invoice creation succeeds — tests that only care about
  // reactivation/completion behavior don't need to restate this.
  createPrimaryInvoice.mockReset().mockResolvedValue({
    invoiceId: "INV",
    invoiceNumber: "INV-NUM",
  });
  applyPaymentToInvoice.mockReset();
  daUnsuspendUser.mockReset();
  sendHostingProvisionedEmail.mockReset();
  sendHostingProvisionedEmail.mockResolvedValue(undefined);
  getCurrentDate.mockReset();
  getCurrentDate.mockReturnValue(NOW);
});

const USER = { _id: "USER_ID", id: "USER_ID", email: "u@x.test", firstName: "Alice" } as never;

function makeCtx(
  razorpay_order_id: string,
  notes: Record<string, unknown> = {}
) {
  return {
    razorpay_order_id,
    razorpay_payment_id: "pay_xyz",
    paymentDetails: { amount: 50000, notes },
    user: USER,
  } as never;
}

describe("handleRenewalPayment — isRenewal detection", () => {
  it("`ord_renew_` prefix → recognized as renewal", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    getOrderByOrderId.mockResolvedValueOnce(null);
    listHostingsForUser.mockResolvedValueOnce([]);
    const result = await handleRenewalPayment(makeCtx("ord_renew_42"));
    expect(result).not.toBeNull();
  });

  it("`rnw_` prefix → recognized as renewal", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    getOrderByOrderId.mockResolvedValueOnce(null);
    listHostingsForUser.mockResolvedValueOnce([]);
    const result = await handleRenewalPayment(makeCtx("rnw_42"));
    expect(result).not.toBeNull();
  });

  it("notes.type:'invoice_payment' → recognized as renewal even with non-renewal order id", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    getOrderByOrderId.mockResolvedValueOnce(null);
    listHostingsForUser.mockResolvedValueOnce([]);
    const result = await handleRenewalPayment(
      makeCtx("ord_42", { type: "invoice_payment" })
    );
    expect(result).not.toBeNull();
  });

  it("none of the 3 signals → returns null (fall through to new-order flow)", async () => {
    const result = await handleRenewalPayment(makeCtx("ord_normal_42"));
    expect(result).toBeNull();
    expect(getOrderByRazorpayOrderId).not.toHaveBeenCalled();
  });
});

describe("handleRenewalPayment — order lookup fallback chain", () => {
  it("Razorpay-id lookup hits → no internal-id fallback call", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      _id: "O1",
      orderId: "rnw_42",
      domains: [],
      save: vi.fn().mockResolvedValue(undefined),
    });
    listHostingsForUser.mockResolvedValueOnce([]);
    await handleRenewalPayment(makeCtx("rnw_42"));
    expect(getOrderByOrderId).not.toHaveBeenCalled();
  });

  it("Razorpay-id miss → falls back to internal orderId lookup", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    getOrderByOrderId.mockResolvedValueOnce({
      _id: "O1",
      orderId: "rnw_42",
      domains: [],
      save: vi.fn().mockResolvedValue(undefined),
    });
    listHostingsForUser.mockResolvedValueOnce([]);
    await handleRenewalPayment(makeCtx("rnw_42"));
    expect(getOrderByOrderId).toHaveBeenCalledWith("rnw_42");
  });
});

describe("handleRenewalPayment — invoice handling", () => {
  it("no existing invoice_id: createPrimaryInvoice called with order/user/cartItems context", async () => {
    const order = {
      _id: "O1",
      orderId: "rnw_42",
      currency: "INR",
      domains: [
        {
          itemType: "hosting",
          domainName: "x.com",
          price: 500,
          currency: "INR",
          registrationPeriod: 1,
        },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    listHostingsForUser.mockResolvedValueOnce([]);
    await handleRenewalPayment(makeCtx("rnw_42"));

    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
    const ctx = createPrimaryInvoice.mock.calls[0][0];
    expect(ctx.order).toBe(order);
    expect(ctx.orderId).toBe("rnw_42");
    expect(ctx.razorpay_payment_id).toBe("pay_xyz");
    expect(ctx.user).toBe(USER);
    expect(ctx.cartItems[0]).toMatchObject({ domainName: "x.com", price: 500 });
  });

  it("cartItems periodUnit defaults: hosting → 'months', domain → 'years'", async () => {
    const order = {
      _id: "O1",
      orderId: "rnw_42",
      currency: "INR",
      domains: [
        { itemType: "hosting", domainName: "h", price: 500, currency: "INR", registrationPeriod: 1 },
        { itemType: "domain", domainName: "d.com", price: 500, currency: "INR", registrationPeriod: 1 },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    listHostingsForUser.mockResolvedValueOnce([]);
    await handleRenewalPayment(makeCtx("rnw_42"));
    const { cartItems } = createPrimaryInvoice.mock.calls[0][0];
    expect(cartItems[0].periodUnit).toBe("months");
    expect(cartItems[1].periodUnit).toBe("years");
  });

  it("createPrimaryInvoice throw SWALLOWED — flow continues to reactivation", async () => {
    const order = {
      _id: "O1",
      orderId: "rnw_42",
      currency: "INR",
      domains: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    createPrimaryInvoice.mockRejectedValueOnce(new Error("both engines down"));
    listHostingsForUser.mockResolvedValueOnce([]);
    const result = await handleRenewalPayment(makeCtx("rnw_42"));
    expect(result).not.toBeNull();
    const body = await result!.json();
    expect(body.success).toBe(true);
  });

  it("existing invoice_id in notes: applies payment + amount converted paise→rupees; createPrimaryInvoice NOT called", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      _id: "O1",
      orderId: "rnw_42",
      domains: [],
      save: vi.fn().mockResolvedValue(undefined),
    });
    applyPaymentToInvoice.mockResolvedValueOnce(true);
    listHostingsForUser.mockResolvedValueOnce([]);
    await handleRenewalPayment(makeCtx("rnw_42", { invoice_id: "INV_EXISTING" }));
    // paymentDetails.amount = 50000 paise → 500 rupees
    expect(applyPaymentToInvoice).toHaveBeenCalledWith(
      "INV_EXISTING",
      500,
      "Razorpay",
      "pay_xyz"
    );
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });
});

describe("handleRenewalPayment — hosting reactivation", () => {
  it("pre-fetches all user hostings ONCE + maps by domainName (O(N+M))", async () => {
    const order = {
      _id: "O1",
      orderId: "rnw_42",
      domains: [
        { itemType: "hosting", domainName: "a.com", periodUnit: "months", registrationPeriod: 1 },
        { itemType: "hosting", domainName: "b.com", periodUnit: "months", registrationPeriod: 1 },
        { itemType: "hosting", domainName: "c.com", periodUnit: "months", registrationPeriod: 1 },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    listHostingsForUser.mockResolvedValueOnce([
      {
        domainName: "a.com",
        status: "expired",
        directAdminUsername: "alice",
        expiryDate: null,
        save: vi.fn().mockResolvedValue(undefined),
      },
      {
        domainName: "b.com",
        status: "active",
        directAdminUsername: "bob",
        expiryDate: new Date("2027-01-01"),
        save: vi.fn().mockResolvedValue(undefined),
      },
    ]);
    await handleRenewalPayment(makeCtx("rnw_42"));
    // listHostingsForUser called EXACTLY ONCE despite 3 hosting items in order
    expect(listHostingsForUser).toHaveBeenCalledTimes(1);
    expect(listHostingsForUser).toHaveBeenCalledWith("USER_ID", { limit: 0 });
  });

  it("daUnsuspendUser called ONLY for status:'expired' or 'suspended' + da username present", async () => {
    const order = {
      _id: "O1",
      orderId: "rnw_42",
      domains: [
        {
          itemType: "hosting",
          domainName: "a.com",
          periodUnit: "months",
          registrationPeriod: 1,
        },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    listHostingsForUser.mockResolvedValueOnce([
      {
        domainName: "a.com",
        status: "active", // NOT expired/suspended → no unsuspend
        directAdminUsername: "alice",
        expiryDate: new Date("2027-01-01"),
        save: vi.fn().mockResolvedValue(undefined),
      },
    ]);
    await handleRenewalPayment(makeCtx("rnw_42"));
    expect(daUnsuspendUser).not.toHaveBeenCalled();
  });

  it("expiryDate in future: extends from THAT date (stack); past: extends from now", async () => {
    const future = new Date("2027-01-01T00:00:00Z");
    const order = {
      _id: "O1",
      orderId: "rnw_42",
      domains: [
        {
          itemType: "hosting",
          domainName: "future.com",
          periodUnit: "months",
          registrationPeriod: 1,
        },
        {
          itemType: "hosting",
          domainName: "past.com",
          periodUnit: "months",
          registrationPeriod: 1,
        },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };
    const futureHosting = {
      domainName: "future.com",
      status: "active",
      directAdminUsername: "u1",
      expiryDate: future,
      save: vi.fn().mockResolvedValue(undefined),
    };
    const pastHosting = {
      domainName: "past.com",
      status: "expired",
      directAdminUsername: "u2",
      expiryDate: new Date("2025-01-01T00:00:00Z"),
      save: vi.fn().mockResolvedValue(undefined),
    };
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    listHostingsForUser.mockResolvedValueOnce([futureHosting, pastHosting]);
    await handleRenewalPayment(makeCtx("rnw_42"));
    // future hosting: stacks +1 month from 2027-01-01
    expect(futureHosting.expiryDate.getUTCFullYear()).toBe(2027);
    expect(futureHosting.expiryDate.getUTCMonth()).toBe(1); // Feb (0-indexed)
    // past hosting: extends from now (2026-06-01) + 1 month → July 2026
    expect(pastHosting.expiryDate.getUTCFullYear()).toBe(2026);
    expect(pastHosting.expiryDate.getUTCMonth()).toBe(6); // July (0-indexed)
  });

  it("periodUnit dispatch: 'minutes' / 'days' / 'years' / default 'months'", async () => {
    const cases = [
      { periodUnit: "minutes", n: 30 },
      { periodUnit: "days", n: 7 },
      { periodUnit: "years", n: 2 },
      { periodUnit: "months", n: 6 },
    ];
    for (const c of cases) {
      const hosting = {
        domainName: "x.com",
        status: "active",
        expiryDate: null,
        save: vi.fn().mockResolvedValue(undefined),
      };
      const order = {
        _id: "O1",
        orderId: "rnw_42",
        domains: [
          {
            itemType: "hosting",
            domainName: "x.com",
            periodUnit: c.periodUnit,
            registrationPeriod: c.n,
          },
        ],
        save: vi.fn().mockResolvedValue(undefined),
      };
      getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
      listHostingsForUser.mockResolvedValueOnce([hosting]);
      await handleRenewalPayment(makeCtx("rnw_42"));
      expect(hosting.expiryDate).not.toBeNull();
    }
  });

  it("renewal stamps renewalInvoiceId + renewalStatus:'paid' + clears last_reminder + next_action_at = expiry-15d", async () => {
    const hosting = {
      domainName: "x.com",
      status: "expired",
      directAdminUsername: "u",
      expiryDate: null,
      save: vi.fn().mockResolvedValue(undefined),
      last_reminder_sent: new Date("2026-05-01"),
      renewalInvoiceId: undefined,
      renewalStatus: undefined,
      next_action_at: undefined,
    };
    const order = {
      _id: "O1",
      orderId: "rnw_42",
      domains: [
        {
          itemType: "hosting",
          domainName: "x.com",
          periodUnit: "months",
          registrationPeriod: 1,
        },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    createPrimaryInvoice.mockResolvedValueOnce({ invoiceId: "INV_99", invoiceNumber: "INV-099" });
    listHostingsForUser.mockResolvedValueOnce([hosting]);
    await handleRenewalPayment(makeCtx("rnw_42"));
    expect(hosting.status).toBe("active");
    expect(hosting.renewalInvoiceId).toBe("INV_99");
    expect(hosting.renewalStatus).toBe("paid");
    expect(hosting.last_reminder_sent).toBeNull();
    expect(hosting.next_action_at).toBeInstanceOf(Date);
    // next_action_at = newExpiry - 15 days
    const expiry = (hosting.expiryDate as unknown as Date).getTime();
    expect((hosting.next_action_at as unknown as Date).getTime()).toBe(
      expiry - 15 * 24 * 60 * 60 * 1000
    );
  });
});

describe("handleRenewalPayment — broad fallback (no specific order)", () => {
  it("no order found → walks user hostings + reactivates suspended/expired ones", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    getOrderByOrderId.mockResolvedValueOnce(null);
    listHostingsForUser.mockResolvedValueOnce([
      {
        directAdminUsername: "u1",
        status: "suspended",
        expiryDate: null,
        save: vi.fn().mockResolvedValue(undefined),
      },
      {
        directAdminUsername: "u2",
        status: "active", // skip — not suspended/expired
        save: vi.fn().mockResolvedValue(undefined),
      },
    ]);
    const result = await handleRenewalPayment(makeCtx("rnw_42"));
    expect(daUnsuspendUser).toHaveBeenCalledTimes(1);
    expect(daUnsuspendUser).toHaveBeenCalledWith({ username: "u1" });
    expect(result).not.toBeNull();
  });
});

describe("handleRenewalPayment — order completion + error tolerance", () => {
  it("renewalOrder marked completed + each domain.status:'registered' + razorpayPaymentId stamped", async () => {
    const domain1 = { itemType: "hosting", domainName: "x.com", status: "pending" };
    const order = {
      _id: "O1",
      orderId: "rnw_42",
      domains: [domain1] as Array<Record<string, unknown>>,
      save: vi.fn().mockResolvedValue(undefined),
      razorpayPaymentId: undefined as string | undefined,
      status: undefined as string | undefined,
    };
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    listHostingsForUser.mockResolvedValueOnce([]);
    await handleRenewalPayment(makeCtx("rnw_42"));
    expect(order.status).toBe("completed");
    expect(order.razorpayPaymentId).toBe("pay_xyz");
    expect(domain1.status).toBe("registered");
  });

  it("reactivation throw SWALLOWED — flow still returns 200", async () => {
    const order = {
      _id: "O1",
      orderId: "rnw_42",
      domains: [
        {
          itemType: "hosting",
          domainName: "x.com",
          periodUnit: "months",
          registrationPeriod: 1,
        },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    listHostingsForUser.mockRejectedValueOnce(new Error("db down"));
    const result = await handleRenewalPayment(makeCtx("rnw_42"));
    const body = await result!.json();
    expect(body.success).toBe(true);
  });

  it("renewalOrder.save throw SWALLOWED — flow still returns 200", async () => {
    const order = {
      _id: "O1",
      orderId: "rnw_42",
      domains: [],
      save: vi.fn().mockRejectedValue(new Error("save conflict")),
    };
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    listHostingsForUser.mockResolvedValueOnce([]);
    const result = await handleRenewalPayment(makeCtx("rnw_42"));
    const body = await result!.json();
    expect(body.success).toBe(true);
  });

  it("final response shape: {success, message: 'services reactivated', orderId} 200", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    getOrderByOrderId.mockResolvedValueOnce(null);
    listHostingsForUser.mockResolvedValueOnce([]);
    const result = await handleRenewalPayment(makeCtx("rnw_42"));
    expect(result!.status).toBe(200);
    const body = await result!.json();
    expect(body).toEqual({
      success: true,
      message: "Payment verified, services reactivated.",
      orderId: "rnw_42",
    });
  });
});
