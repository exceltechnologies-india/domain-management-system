/**
 * Service-layer integration tests for lib/services/orders.ts.
 *
 * Hits a real in-memory MongoDB (mongodb-memory-server) so the helpers
 * exercise their actual queries. No application-layer mocks — the service
 * is the unit under test.
 *
 * Scope: every helper added or extended during the H1 Order migration
 * (passes 1-3). Covers ownership scoping, soft-delete filtering,
 * idempotency-claim races, populate-option pass-through, and the
 * lifetime-trial gate.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import Order from "@/models/Order";
import {
  claimOrderForPrimaryInvoice,
  claimPendingOrderForProcessing,
  clearOrderInvoiceNumber,
  createOrder,
  findOrderByDomain,
  findOrderByDomainForUser,
  findOrderByRazorpayPaymentField,
  findPriorHostingOrderForUser,
  flagCreditNotePending,
  listCreditNotePendingOrders,
  getOrderById,
  getOrderByIdOrOrderId,
  getOrderByOrderId,
  getOrderByRazorpayOrderId,
  listAllOrdersForAdminDomains,
  listOrdersByRazorpayPaymentIds,
  listOrdersForUser,
  listFailedInvoiceOrders,
  listInvoiceOrdersAdmin,
  listStrandedProcessingOrders,
  listRecentCompletedOrdersForUser,
  listStuckCompletedOrders,
  listUninvoicedPaidOrdersAdmin,
  listUserInvoiceOrders,
  recordPrimaryInvoiceForOrder,
  markInvoiceCreationFailed,
  releasePrimaryInvoiceClaim,
  userHasPriorTrialOrder,
} from "@/lib/services/orders";

const validUserId = () => new mongoose.Types.ObjectId();

// Order schema requires several razorpay fields + paymentVerification subdoc.
// Helper builds a minimal-valid payload so individual tests can override the
// fields they care about without re-stating the whole skeleton.
//
// NOTE: default status is "paid" — the Order schema's pre-save hook
// auto-generates an `invoiceNumber` when status is "completed", which would
// pollute the invoice-list / dupe-key assertions. We used to default to
// "pending" for the same reason, but `pending` now means "checkout
// intent, not yet paid" and is filtered out of user-visible listings.
// Tests that need either extreme ("pending" for the lifecycle suite,
// "completed" for invoice-number tests) override it explicitly.
function buildOrderPayload(overrides: Record<string, unknown> = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  return {
    orderId: `ord_${tag}`,
    paymentId: `pay_${tag}`,
    userId: validUserId(),
    razorpayOrderId: `rzp_ord_${tag}`,
    razorpayPaymentId: `rzp_pay_${tag}`,
    razorpaySignature: `sig_${tag}`,
    amount: 1000,
    currency: "INR",
    status: "paid",
    domains: [],
    successfulDomains: [],
    paymentVerification: {
      verifiedAt: new Date(),
      paymentStatus: "captured",
      paymentAmount: 1000,
      paymentCurrency: "INR",
      razorpayOrderId: `rzp_ord_${tag}`,
    },
    ...overrides,
  };
}

beforeAll(async () => {
  // Setup runs in tests/integration/setup.ts; ensure connection is hot before
  // tests hit it. mongoose.connect() is idempotent — this is just a guard.
  expect(mongoose.connection.readyState).toBe(1);
  // Build the schema-declared indexes (incl. the unique sparse one on
  // `invoiceNumber`) so the E11000-collision test can actually trip them.
  await Order.syncIndexes();
});

beforeEach(clearAllCollections);

describe("createOrder", () => {
  it("persists a new order and returns the saved document", async () => {
    const userId = validUserId();
    const order = await createOrder(
      buildOrderPayload({ orderId: "ord_create_1", userId })
    );

    expect(order._id).toBeDefined();
    expect(order.orderId).toBe("ord_create_1");

    const found = await Order.findById(order._id);
    expect(found?.userId.toString()).toBe(userId.toString());
  });
});

describe("getOrderByOrderId", () => {
  it("looks up an order by its user-facing orderId", async () => {
    await createOrder(buildOrderPayload({ orderId: "ord_lookup_1" }));

    const found = await getOrderByOrderId("ord_lookup_1");
    expect(found?.orderId).toBe("ord_lookup_1");
  });

  it("returns null when nothing matches", async () => {
    expect(await getOrderByOrderId("ord_does_not_exist")).toBeNull();
  });

  it("populates userId when the populate option is supplied", async () => {
    // Insert a minimal User row so populate has something to attach.
    const userId = validUserId();
    await mongoose.connection.db?.collection("users").insertOne({
      _id: userId,
      email: "x@y.test",
      firstName: "First",
      lastName: "Last",
    });

    await createOrder(buildOrderPayload({ orderId: "ord_pop_1", userId }));

    const populated = (await getOrderByOrderId("ord_pop_1", {
      populate: { path: "userId", select: "email firstName lastName" },
    })) as unknown as { userId: { email: string; firstName: string } };

    expect(populated.userId.email).toBe("x@y.test");
    expect(populated.userId.firstName).toBe("First");
  });
});

describe("findOrderByDomainForUser", () => {
  it("returns the order when the domain belongs to the user", async () => {
    const userId = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_uds_1",
        userId,
        domains: [
          {
            domainName: "alpha.com",
            price: 800,
            currency: "INR",
            registrationPeriod: 1,
            status: "registered",
            bookingStatus: [
              { step: "domain_registered", message: "ok", progress: 100, timestamp: new Date() },
            ],
          },
        ],
      })
    );

    const found = await findOrderByDomainForUser(userId, "alpha.com");
    expect(found?.orderId).toBe("ord_uds_1");
  });

  it("returns null when the domain exists under a different user (tenant isolation)", async () => {
    const ownerId = validUserId();
    const otherId = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_uds_2",
        userId: ownerId,
        domains: [
          {
            domainName: "beta.com",
            price: 800,
            currency: "INR",
            registrationPeriod: 1,
            status: "registered",
            bookingStatus: [
              { step: "domain_registered", message: "ok", progress: 100, timestamp: new Date() },
            ],
          },
        ],
      })
    );

    expect(await findOrderByDomainForUser(otherId, "beta.com")).toBeNull();
  });

  it("ignores soft-deleted orders", async () => {
    const userId = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_uds_3",
        userId,
        isDeleted: true,
        domains: [
          {
            domainName: "gamma.com",
            price: 800,
            currency: "INR",
            registrationPeriod: 1,
            status: "registered",
            bookingStatus: [
              { step: "domain_registered", message: "ok", progress: 100, timestamp: new Date() },
            ],
          },
        ],
      })
    );

    expect(await findOrderByDomainForUser(userId, "gamma.com")).toBeNull();
  });
});

describe("findOrderByDomain (admin)", () => {
  it("returns the order regardless of owner, but still skips soft-deleted", async () => {
    await createOrder(
      buildOrderPayload({
        orderId: "ord_adm_1",
        domains: [
          {
            domainName: "delta.com",
            price: 1, currency: "INR", registrationPeriod: 1,
            status: "registered",
            bookingStatus: [{ step: "domain_registered", message: "ok", progress: 100, timestamp: new Date() }],
          },
        ],
      })
    );
    await createOrder(
      buildOrderPayload({
        orderId: "ord_adm_2",
        isDeleted: true,
        domains: [
          {
            domainName: "epsilon.com",
            price: 1, currency: "INR", registrationPeriod: 1,
            status: "registered",
            bookingStatus: [{ step: "domain_registered", message: "ok", progress: 100, timestamp: new Date() }],
          },
        ],
      })
    );

    expect((await findOrderByDomain("delta.com"))?.orderId).toBe("ord_adm_1");
    expect(await findOrderByDomain("epsilon.com")).toBeNull();
  });
});

describe("findOrderByRazorpayPaymentField + getOrderByRazorpayOrderId", () => {
  it("each look up by their respective fields", async () => {
    await createOrder(
      buildOrderPayload({
        orderId: "ord_rzp_1",
        razorpayOrderId: "rzp_ord_lookup",
        razorpayPaymentId: "rzp_pay_lookup",
      })
    );
    expect((await findOrderByRazorpayPaymentField("rzp_pay_lookup"))?.orderId).toBe("ord_rzp_1");
    expect((await getOrderByRazorpayOrderId("rzp_ord_lookup"))?.orderId).toBe("ord_rzp_1");
  });

  it("getOrderByRazorpayOrderId narrows by orderType when supplied", async () => {
    await createOrder(
      buildOrderPayload({
        orderId: "ord_upg_1",
        razorpayOrderId: "rzp_upg",
        orderType: "hosting_upgrade",
      })
    );
    expect(
      (await getOrderByRazorpayOrderId("rzp_upg", { orderType: "hosting_upgrade" }))?.orderId
    ).toBe("ord_upg_1");
    // Wrong orderType → no match.
    expect(await getOrderByRazorpayOrderId("rzp_upg", { orderType: "renewal" })).toBeNull();
  });
});

describe("userHasPriorTrialOrder", () => {
  it("returns true when any prior trial order exists for the user", async () => {
    const userId = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_trial_1",
        userId,
        orderType: "hosting_trial",
      })
    );
    expect(await userHasPriorTrialOrder(userId)).toBe(true);
  });

  it("returns false when only non-trial orders exist", async () => {
    const userId = validUserId();
    await createOrder(buildOrderPayload({ orderId: "ord_nontrial_1", userId }));
    expect(await userHasPriorTrialOrder(userId)).toBe(false);
  });

  it("returns false for an ABANDONED tokens trial (status 'pending' + placeholder razorpayPaymentId 'pending') — customer never completed the ₹2 mandate, so they aren't locked out", async () => {
    const userId = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_trial_abandoned",
        userId,
        orderType: "hosting_trial",
        status: "pending",
        razorpayPaymentId: "pending",
      })
    );
    expect(await userHasPriorTrialOrder(userId)).toBe(false);
  });

  it("returns true for an ACTIVE manual trial (status 'pending' but razorpayPaymentId 'manual') — a real, provisioned trial still counts", async () => {
    const userId = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_trial_manual",
        userId,
        orderType: "hosting_trial",
        status: "pending",
        razorpayPaymentId: "manual",
      })
    );
    expect(await userHasPriorTrialOrder(userId)).toBe(true);
  });

  it("returns true for a COMPLETED tokens trial (status 'completed' + real pay_id) — mandate was set up, trial consumed", async () => {
    const userId = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_trial_completed",
        userId,
        orderType: "hosting_trial",
        status: "completed",
        razorpayPaymentId: "pay_realtokenid",
      })
    );
    expect(await userHasPriorTrialOrder(userId)).toBe(true);
  });
});

describe("findPriorHostingOrderForUser", () => {
  it("matches via userId OR userEmail (migration window)", async () => {
    const userId = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_prior_1",
        userId: validUserId(), // intentionally a different id
        userEmail: "guest@host.test",
        status: "completed",
        domains: [
          {
            domainName: "h1.com",
            price: 1, currency: "INR", registrationPeriod: 1,
            status: "registered",
            itemType: "hosting",
            bookingStatus: [{ step: "domain_registered", message: "ok", progress: 100, timestamp: new Date() }],
          },
        ],
      })
    );

    const found = await findPriorHostingOrderForUser(userId, "guest@host.test");
    expect(found?.orderId).toBe("ord_prior_1");
  });

  it("ignores orders in failed/refunded status", async () => {
    const userId = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_prior_failed",
        userId,
        status: "failed",
        domains: [
          {
            domainName: "h2.com",
            price: 1, currency: "INR", registrationPeriod: 1,
            status: "failed",
            itemType: "hosting",
            bookingStatus: [{ step: "domain_failed", message: "x", progress: 100, timestamp: new Date() }],
          },
        ],
      })
    );
    expect(await findPriorHostingOrderForUser(userId, "n/a@host.test")).toBeNull();
  });
});

describe("listOrdersForUser", () => {
  it("returns only the requesting user's non-deleted orders, newest first", async () => {
    const owner = validUserId();
    const other = validUserId();

    await createOrder(
      buildOrderPayload({ orderId: "ord_list_a", userId: owner })
    );
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct createdAt
    await createOrder(
      buildOrderPayload({ orderId: "ord_list_b", userId: owner })
    );
    await createOrder(
      buildOrderPayload({ orderId: "ord_list_other", userId: other })
    );
    await createOrder(
      buildOrderPayload({
        orderId: "ord_list_deleted",
        userId: owner,
        isDeleted: true,
      })
    );

    const list = await listOrdersForUser(owner, { populateUser: false });
    expect(list.map((o) => o.orderId)).toEqual(["ord_list_b", "ord_list_a"]);
  });

  it("respects limit:0 as unbounded", async () => {
    const owner = validUserId();
    for (let i = 0; i < 55; i++) {
      await createOrder(
        buildOrderPayload({ orderId: `ord_bulk_${i}`, userId: owner })
      );
    }
    const all = await listOrdersForUser(owner, { limit: 0, populateUser: false });
    // Without unbounded support this would cap at 50.
    expect(all.length).toBe(55);
  });
});

describe("listUserInvoiceOrders", () => {
  it("only returns orders that have an invoiceNumber set", async () => {
    const owner = validUserId();
    await createOrder(
      buildOrderPayload({ orderId: "ord_inv_1", userId: owner, invoiceNumber: "INV-1" })
    );
    await createOrder(
      buildOrderPayload({ orderId: "ord_inv_2", userId: owner })
    );
    const list = await listUserInvoiceOrders(owner);
    // The helper projects only the fields the invoices UI renders —
    // `orderId` is NOT in that projection, so assert on `invoiceNumber`.
    expect(list.map((o) => o.invoiceNumber)).toEqual(["INV-1"]);
  });
});

describe("listRecentCompletedOrdersForUser", () => {
  it("filters by status:completed and createdAt within the window", async () => {
    const owner = validUserId();
    const old = await createOrder(
      buildOrderPayload({ orderId: "ord_recent_old", userId: owner, status: "completed" })
    );
    // Backdate via the raw driver — mongoose's update path treats
    // timestamp fields specially and will silently re-set them.
    await mongoose.connection.db?.collection("orders").updateOne(
      { _id: old._id },
      { $set: { createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }
    );
    await createOrder(
      buildOrderPayload({ orderId: "ord_recent_new", userId: owner, status: "completed" })
    );

    const list = await listRecentCompletedOrdersForUser(owner, { withinDays: 14 });
    expect(list.map((o) => o.orderId)).toEqual(["ord_recent_new"]);
  });
});

describe("listStuckCompletedOrders (cron)", () => {
  it("returns completed orders older than the cutoff with a still-pending domain", async () => {
    const stuck = await createOrder(
      buildOrderPayload({
        orderId: "ord_stuck_1",
        status: "completed",
        domains: [
          {
            domainName: "pendle.com",
            price: 1, currency: "INR", registrationPeriod: 1,
            status: "pending",
            bookingStatus: [{ step: "payment_verified", message: "x", progress: 50, timestamp: new Date() }],
          },
        ],
      })
    );
    // Backdate via the raw driver — mongoose's update path treats
    // timestamp fields specially and will silently re-set them.
    await mongoose.connection.db?.collection("orders").updateOne(
      { _id: stuck._id },
      { $set: { createdAt: new Date(Date.now() - 60 * 60_000) } } // 1 hour old
    );

    const list = await listStuckCompletedOrders({ staleAfterMs: 30 * 60_000 });
    expect(list.map((o) => o.orderId)).toEqual(["ord_stuck_1"]);
  });
});

describe("listAllOrdersForAdminDomains", () => {
  it("returns every order (including soft-deleted) newest first", async () => {
    await createOrder(buildOrderPayload({ orderId: "ord_admin_a" }));
    await createOrder(
      buildOrderPayload({ orderId: "ord_admin_b", isDeleted: true })
    );

    const all = (await listAllOrdersForAdminDomains()).map((o) => o.orderId);
    expect(all.sort()).toEqual(["ord_admin_a", "ord_admin_b"]);
  });
});

describe("listOrdersByRazorpayPaymentIds", () => {
  it("matches the supplied id list and short-circuits on empty input", async () => {
    await createOrder(
      buildOrderPayload({
        orderId: "ord_byrzp_1",
        razorpayPaymentId: "rzp_pay_a",
      })
    );
    expect(await listOrdersByRazorpayPaymentIds([])).toEqual([]);
    const list = await listOrdersByRazorpayPaymentIds(["rzp_pay_a", "rzp_pay_missing"]);
    expect(list.map((o) => o.orderId)).toEqual(["ord_byrzp_1"]);
  });
});

describe("getOrderByIdOrOrderId", () => {
  it("accepts either a Mongo _id (24-hex) or the user-facing orderId", async () => {
    const order = await createOrder(
      buildOrderPayload({ orderId: "ord_either_1" })
    );

    expect((await getOrderByIdOrOrderId("ord_either_1"))?.orderId).toBe("ord_either_1");
    expect(
      (await getOrderByIdOrOrderId(String(order._id)))?.orderId
    ).toBe("ord_either_1");
  });

  it("returns null for an unknown identifier", async () => {
    // 24-hex but unknown
    expect(await getOrderByIdOrOrderId("507f1f77bcf86cd799439011")).toBeNull();
    // Non-hex orderId
    expect(await getOrderByIdOrOrderId("ord_unknown_xyz")).toBeNull();
  });
});

describe("clearOrderInvoiceNumber", () => {
  it("unsets the invoiceNumber field on the matched order", async () => {
    const order = await createOrder(
      buildOrderPayload({ orderId: "ord_clear_1", invoiceNumber: "INV-9" })
    );
    const { modifiedCount } = await clearOrderInvoiceNumber(order._id);
    expect(modifiedCount).toBe(1);
    const refetched = await Order.findById(order._id);
    expect(refetched?.invoiceNumber).toBeUndefined();
  });
});

// Zoho Books was removed on 24 Sep 2026. Its `zohoInvoiceId` sentinel
// ("pending_creation" / "creation_failed") is replaced by `invoiceFailedAt`,
// and the only thing that means "already invoiced" is `invoiceProvider`.
describe("invoice-failure lifecycle", () => {
  it("markInvoiceCreationFailed stamps invoiceFailedAt + reason on an uninvoiced order", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_fail_1" }));
    await markInvoiceCreationFailed(order._id, "COMPANY_STATE is not configured");
    const found = await Order.findById(order._id);
    expect(found?.invoiceFailedAt).toBeInstanceOf(Date);
    expect(found?.invoiceFailureReason).toBe("COMPANY_STATE is not configured");
    expect(found?.invoiceProvider).toBeUndefined();
  });

  it("markInvoiceCreationFailed caps the reason at 500 chars", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_fail_cap" }));
    await markInvoiceCreationFailed(order._id, "e".repeat(2000));
    const found = await Order.findById(order._id);
    expect(found?.invoiceFailureReason).toHaveLength(500);
  });

  it("markInvoiceCreationFailed is a NO-OP on an order that already has an invoice (either engine)", async () => {
    const primary = await createOrder(buildOrderPayload({ orderId: "ord_fail_primary" }));
    await recordPrimaryInvoiceForOrder(primary._id, {
      invoiceNumber: "TI/2026-27/00101",
      gstRate: 18,
      taxableValue: 1000,
      cgst: 90,
      sgst: 90,
      igst: 0,
      placeOfSupply: "Delhi",
    });
    const historical = await createOrder(
      buildOrderPayload({ orderId: "ord_fail_zoho", invoiceProvider: "zoho" })
    );

    await markInvoiceCreationFailed(primary._id, "late failure");
    await markInvoiceCreationFailed(historical._id, "late failure");

    for (const id of [primary._id, historical._id]) {
      const found = await Order.findById(id);
      expect(found?.invoiceFailedAt).toBeUndefined();
      expect(found?.invoiceFailureReason).toBeUndefined();
    }
  });

  it("recordPrimaryInvoiceForOrder clears an earlier failure once the invoice lands", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_fail_then_ok" }));
    await markInvoiceCreationFailed(order._id, "counter unreachable");
    await claimOrderForPrimaryInvoice(order._id);
    await recordPrimaryInvoiceForOrder(order._id, {
      invoiceNumber: "TI/2026-27/00101",
      gstRate: 18,
      taxableValue: 1000,
      cgst: 90,
      sgst: 90,
      igst: 0,
      placeOfSupply: "Delhi",
    });
    const found = await Order.findById(order._id);
    expect(found?.invoiceProvider).toBe("primary");
    expect(found?.invoiceFailedAt).toBeUndefined();
    expect(found?.invoiceFailureReason).toBeUndefined();
  });

  it("listFailedInvoiceOrders lists only the user's paid orders with a KNOWN failure and no invoice", async () => {
    const userId = validUserId();
    const failed = await createOrder(
      buildOrderPayload({ orderId: "ord_lf_failed", userId, status: "completed" })
    );
    await markInvoiceCreationFailed(failed._id, "boom");
    // Paid but never attempted — NOT retried (no path mints a first invoice
    // for an order nobody tried to invoice).
    await createOrder(buildOrderPayload({ orderId: "ord_lf_untried", userId, status: "completed" }));
    // Another user's failure — not listed.
    const other = await createOrder(
      buildOrderPayload({ orderId: "ord_lf_other", userId: validUserId(), status: "completed" })
    );
    await markInvoiceCreationFailed(other._id, "boom");
    // Soft-deleted failure — not listed.
    const deleted = await createOrder(
      buildOrderPayload({ orderId: "ord_lf_deleted", userId, status: "completed" })
    );
    await markInvoiceCreationFailed(deleted._id, "boom");
    await Order.updateOne({ _id: deleted._id }, { $set: { isDeleted: true } });

    const ids = (await listFailedInvoiceOrders(String(userId))).map((o) => o.orderId);
    expect(ids).toEqual(["ord_lf_failed"]);
  });

  it("listUninvoicedPaidOrdersAdmin: paid + no invoice, excluding ₹0, trial, invoiced and deleted orders", async () => {
    await createOrder(buildOrderPayload({ orderId: "ord_un_paid", status: "completed" }));
    await createOrder(buildOrderPayload({ orderId: "ord_un_zero", status: "completed", amount: 0 }));
    await createOrder(
      buildOrderPayload({ orderId: "ord_un_trial", status: "completed", orderType: "hosting_trial" })
    );
    await createOrder(
      buildOrderPayload({ orderId: "ord_un_zoho", status: "completed", invoiceProvider: "zoho" })
    );
    const invoiced = await createOrder(buildOrderPayload({ orderId: "ord_un_primary", status: "completed" }));
    await recordPrimaryInvoiceForOrder(invoiced._id, {
      invoiceNumber: "TI/2026-27/00101",
      gstRate: 18,
      taxableValue: 1000,
      cgst: 90,
      sgst: 90,
      igst: 0,
      placeOfSupply: "Delhi",
    });
    const deleted = await createOrder(buildOrderPayload({ orderId: "ord_un_deleted", status: "completed" }));
    await Order.updateOne({ _id: deleted._id }, { $set: { isDeleted: true } });
    await createOrder(buildOrderPayload({ orderId: "ord_un_pending", status: "pending" }));

    const ids = (await listUninvoicedPaidOrdersAdmin()).map((o) => o.orderId);
    expect(ids).toEqual(["ord_un_paid"]);
  });
});

describe("listStrandedProcessingOrders (the check that would have caught the lost purchase)", () => {
  // Nothing else in the codebase can see this state: check-unprovisioned
  // filters status:"completed", and pending-sweeper does not query Orders at
  // all. A paid customer with no hosting and no invoice was therefore
  // invisible until they complained.
  it("finds a paid order stuck at processing with unprovisioned items", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    await createOrder(
      buildOrderPayload({
        razorpayOrderId: rzp,
        status: "processing",
        domains: [{ domainName: `s-${tag}.com`, price: 100, currency: "INR", registrationPeriod: 1, status: "pending" }],
      })
    );
    await Order.updateOne(
      { razorpayOrderId: rzp },
      { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } },
      { timestamps: false }
    );

    const found = await listStrandedProcessingOrders({ staleAfterMs: 15 * 60 * 1000 });
    expect(found.map((o) => o.razorpayOrderId)).toContain(rzp);
  });

  it("does NOT report an order that is still inside the cutoff", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    await createOrder(
      buildOrderPayload({
        razorpayOrderId: rzp,
        status: "processing",
        domains: [{ domainName: `f-${tag}.com`, price: 100, currency: "INR", registrationPeriod: 1, status: "pending" }],
      })
    );
    // ~55s of real provisioning must never be reported as stranded.
    const found = await listStrandedProcessingOrders({ staleAfterMs: 15 * 60 * 1000 });
    expect(found.map((o) => o.razorpayOrderId)).not.toContain(rzp);
  });

  it("does NOT report a processing order whose items are all provisioned", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    await createOrder(
      buildOrderPayload({
        razorpayOrderId: rzp,
        status: "processing",
        domains: [{ domainName: `d-${tag}.com`, price: 100, currency: "INR", registrationPeriod: 1, status: "registered" }],
      })
    );
    await Order.updateOne(
      { razorpayOrderId: rzp },
      { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } },
      { timestamps: false }
    );
    const found = await listStrandedProcessingOrders({ staleAfterMs: 15 * 60 * 1000 });
    expect(found.map((o) => o.razorpayOrderId)).not.toContain(rzp);
  });

  it("ignores soft-deleted orders", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    await createOrder(
      buildOrderPayload({
        razorpayOrderId: rzp,
        status: "processing",
        domains: [{ domainName: `x-${tag}.com`, price: 100, currency: "INR", registrationPeriod: 1, status: "pending" }],
      })
    );
    await Order.updateOne(
      { razorpayOrderId: rzp },
      { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000), isDeleted: true } },
      { timestamps: false }
    );
    const found = await listStrandedProcessingOrders({ staleAfterMs: 15 * 60 * 1000 });
    expect(found.map((o) => o.razorpayOrderId)).not.toContain(rzp);
  });
});

describe("claimPendingOrderForProcessing (pending → processing race)", () => {
  // The /verify route + /razorpay/webhook can fire against the same order
  // within milliseconds of each other (user closes tab right after paying,
  // Razorpay then sends the captured webhook). Both code paths call this
  // claim helper; only one must win. The guard is the atomic
  // findOneAndUpdate({status: "pending"}) — losers see status != "pending"
  // and bail out as no-ops.
  it("first caller claims; second caller sees null", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    await createOrder(buildOrderPayload({ razorpayOrderId: rzp, status: "pending" }));

    const winner = await claimPendingOrderForProcessing(rzp, {
      razorpayPaymentId: "rzp_pay_win",
    });
    expect(winner).not.toBeNull();
    expect(winner?.status).toBe("processing");
    expect(winner?.razorpayPaymentId).toBe("rzp_pay_win");

    const loser = await claimPendingOrderForProcessing(rzp, {
      razorpayPaymentId: "rzp_pay_lose",
    });
    // Status is now "processing" — claim guard rejects.
    expect(loser).toBeNull();
  });

  it("concurrent calls — exactly one returns non-null", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    await createOrder(buildOrderPayload({ razorpayOrderId: rzp, status: "pending" }));

    // Fire both claim attempts in parallel against the same pending row.
    // findOneAndUpdate is atomic at the Mongo layer, so one must win.
    const [a, b] = await Promise.all([
      claimPendingOrderForProcessing(rzp, { razorpayPaymentId: "rzp_pay_a" }),
      claimPendingOrderForProcessing(rzp, { razorpayPaymentId: "rzp_pay_b" }),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it("returns null when no pending order exists for the razorpay id", async () => {
    const result = await claimPendingOrderForProcessing("rzp_ord_does_not_exist", {});
    expect(result).toBeNull();
  });

  // ── Recovery mode: staleAfterMs ──────────────────────────────────────────
  //
  // A handler that WON the claim and then died leaves the order stranded at
  // "processing" forever: the webhook's claim sees a non-pending status and
  // no-ops, and no cron queries Orders in "processing" at all. That is how a
  // real Rs.1500 purchase was lost on 2026-09-07. `staleAfterMs` lets a
  // recovery caller re-claim such a row — and must NEVER let it steal an order
  // from a handler that is still working.
  it("staleAfterMs re-claims an order stranded at processing past the cutoff", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    await createOrder(buildOrderPayload({ razorpayOrderId: rzp, status: "processing" }));
    // Backdate updatedAt to simulate a handler that died an hour ago.
    await Order.updateOne(
      { razorpayOrderId: rzp },
      { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } },
      { timestamps: false }
    );

    const rescued = await claimPendingOrderForProcessing(
      rzp,
      { razorpayPaymentId: "rzp_pay_rescue" },
      { staleAfterMs: 15 * 60 * 1000 }
    );
    expect(rescued).not.toBeNull();
    expect(rescued?.status).toBe("processing");
    expect(rescued?.razorpayPaymentId).toBe("rzp_pay_rescue");
  });

  it("staleAfterMs does NOT steal an order from a still-running handler", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    // Freshly claimed — updatedAt is now, i.e. a handler mid-provision.
    await createOrder(buildOrderPayload({ razorpayOrderId: rzp, status: "processing" }));

    const stolen = await claimPendingOrderForProcessing(
      rzp,
      { razorpayPaymentId: "rzp_pay_thief" },
      { staleAfterMs: 15 * 60 * 1000 }
    );
    // Inside the cutoff -> untouchable. This is the guard that stops a
    // recovery sweep double-provisioning a live order.
    expect(stolen).toBeNull();
  });

  it("without staleAfterMs the behaviour is unchanged — processing stays unclaimable", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    await createOrder(buildOrderPayload({ razorpayOrderId: rzp, status: "processing" }));
    await Order.updateOne(
      { razorpayOrderId: rzp },
      { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } },
      { timestamps: false }
    );
    // Every existing caller passes no opts and must be completely unaffected.
    const result = await claimPendingOrderForProcessing(rzp, { razorpayPaymentId: "x" });
    expect(result).toBeNull();
  });

  it("returns null when order exists but already past pending", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    // Already processing — webhook arriving after /verify already claimed.
    await createOrder(buildOrderPayload({ razorpayOrderId: rzp, status: "processing" }));
    const result = await claimPendingOrderForProcessing(rzp, {
      razorpayPaymentId: "rzp_pay_late",
    });
    expect(result).toBeNull();
  });

  it("stamps paymentVerification subdoc when supplied", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const rzp = `rzp_ord_${tag}`;
    await createOrder(buildOrderPayload({ razorpayOrderId: rzp, status: "pending" }));

    const claimed = await claimPendingOrderForProcessing(rzp, {
      razorpayPaymentId: "rzp_pay_pv",
      paymentVerification: {
        verifiedAt: new Date("2026-05-21T10:00:00Z"),
        paymentStatus: "captured",
        paymentAmount: 12345,
        paymentCurrency: "INR",
        razorpayOrderId: rzp,
      },
    });
    expect(claimed?.paymentVerification?.paymentStatus).toBe("captured");
    expect(claimed?.paymentVerification?.paymentAmount).toBe(12345);
  });
});

// ─── Primary-invoice claim (Primary Billing Integration Phase 1c) ──────────────
describe("claimOrderForPrimaryInvoice / releasePrimaryInvoiceClaim / recordPrimaryInvoiceForOrder", () => {
  it("claims an unclaimed, unissued order", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_claim_1" }));
    const claimed = await claimOrderForPrimaryInvoice(order._id);
    expect(claimed).toBe(true);

    const found = await Order.findById(order._id);
    expect(found?.primaryInvoiceClaimedAt).toBeInstanceOf(Date);
  });

  it("refuses a second concurrent claim on the same order", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_claim_2" }));
    expect(await claimOrderForPrimaryInvoice(order._id)).toBe(true);
    expect(await claimOrderForPrimaryInvoice(order._id)).toBe(false);
  });

  it("never double-claims under real concurrency (10-way race, exactly one winner)", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_claim_race" }));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimOrderForPrimaryInvoice(order._id))
    );
    expect(results.filter(Boolean).length).toBe(1);
  });

  it("refuses a claim once invoiceProvider is already set (invoice already issued)", async () => {
    const order = await createOrder(
      buildOrderPayload({ orderId: "ord_claim_3", invoiceProvider: "zoho" as never })
    );
    expect(await claimOrderForPrimaryInvoice(order._id)).toBe(false);
  });

  it("refuses an un-migrated Zoho-invoiced order (raw zohoInvoiceId, no invoiceProvider yet)", async () => {
    // Deploy-order safety net: before migration 009 runs, a historical order
    // still carries the raw `zohoInvoiceId` and no `invoiceProvider`. The
    // field is not in the schema any more, so write it through the raw
    // collection exactly as the old code left it.
    const order = await createOrder(buildOrderPayload({ orderId: "ord_claim_legacy" }));
    await Order.collection.updateOne({ _id: order._id }, { $set: { zohoInvoiceId: "4655000000123" } });
    expect(await claimOrderForPrimaryInvoice(order._id)).toBe(false);
    expect(await claimOrderForPrimaryInvoice(order._id, { staleClaimAfterMs: 1 })).toBe(false);
  });

  // Stale-claim recovery (Phase 1c audit, 2026-09-03). Added when the
  // issue-invoice (then sync-zoho-invoice) Cloud Tasks worker became the first ASYNCHRONOUS,
  // queue-retried caller of the chokepoint: without stealing, a crash between
  // claim and persist strands the order behind a lease no retry can take, and
  // the renewal stays permanently uninvoiced.
  describe("staleClaimAfterMs", () => {
    /** Backdates an existing claim so it looks abandoned. */
    async function ageClaim(orderId: mongoose.Types.ObjectId, ms: number) {
      await Order.updateOne(
        { _id: orderId },
        { $set: { primaryInvoiceClaimedAt: new Date(Date.now() - ms) } }
      );
    }

    it("steals a claim older than the threshold", async () => {
      const order = await createOrder(buildOrderPayload({ orderId: "ord_stale_1" }));
      expect(await claimOrderForPrimaryInvoice(order._id)).toBe(true);
      await ageClaim(order._id, 10 * 60 * 1000);

      expect(
        await claimOrderForPrimaryInvoice(order._id, {
          staleClaimAfterMs: 5 * 60 * 1000,
        })
      ).toBe(true);
    });

    it("re-stamps primaryInvoiceClaimedAt when it steals, so the stealer's own claim starts fresh", async () => {
      const order = await createOrder(buildOrderPayload({ orderId: "ord_stale_2" }));
      await claimOrderForPrimaryInvoice(order._id);
      await ageClaim(order._id, 10 * 60 * 1000);
      const before = (await Order.findById(order._id))?.primaryInvoiceClaimedAt;

      await claimOrderForPrimaryInvoice(order._id, {
        staleClaimAfterMs: 5 * 60 * 1000,
      });

      const after = (await Order.findById(order._id))?.primaryInvoiceClaimedAt;
      expect(after!.getTime()).toBeGreaterThan(before!.getTime());
    });

    it("does NOT steal a claim younger than the threshold (a genuinely in-flight attempt is left alone)", async () => {
      const order = await createOrder(buildOrderPayload({ orderId: "ord_stale_3" }));
      expect(await claimOrderForPrimaryInvoice(order._id)).toBe(true);
      await ageClaim(order._id, 60 * 1000);

      expect(
        await claimOrderForPrimaryInvoice(order._id, {
          staleClaimAfterMs: 5 * 60 * 1000,
        })
      ).toBe(false);
    });

    it("the DEFAULT (no opts) never steals, however old the claim — synchronous callers must keep skipping", async () => {
      const order = await createOrder(buildOrderPayload({ orderId: "ord_stale_4" }));
      await claimOrderForPrimaryInvoice(order._id);
      await ageClaim(order._id, 24 * 60 * 60 * 1000);

      expect(await claimOrderForPrimaryInvoice(order._id)).toBe(false);
    });

    it("staleClaimAfterMs: 0 is treated as 'no stealing' (falsy guard), not as 'steal everything'", async () => {
      const order = await createOrder(buildOrderPayload({ orderId: "ord_stale_5" }));
      await claimOrderForPrimaryInvoice(order._id);
      await ageClaim(order._id, 24 * 60 * 60 * 1000);

      expect(
        await claimOrderForPrimaryInvoice(order._id, { staleClaimAfterMs: 0 })
      ).toBe(false);
    });

    it("**can NEVER steal a COMPLETED invoice, however large the threshold** — the invoiceProvider filter still applies, so no payment can be invoiced twice", async () => {
      const order = await createOrder(buildOrderPayload({ orderId: "ord_stale_6" }));
      await claimOrderForPrimaryInvoice(order._id);
      await recordPrimaryInvoiceForOrder(order._id, {
        invoiceNumber: "TI/2026-27/00011",
        gstRate: 18,
        taxableValue: 1000,
        cgst: 90,
        sgst: 90,
        igst: 0,
        placeOfSupply: "Delhi",
      });
      await ageClaim(order._id, 365 * 24 * 60 * 60 * 1000);

      expect(
        await claimOrderForPrimaryInvoice(order._id, { staleClaimAfterMs: 1 })
      ).toBe(false);
    });

    it("stealing is still atomic — 10 concurrent stealers, exactly one winner", async () => {
      const order = await createOrder(buildOrderPayload({ orderId: "ord_stale_race" }));
      await claimOrderForPrimaryInvoice(order._id);
      await ageClaim(order._id, 10 * 60 * 1000);

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          claimOrderForPrimaryInvoice(order._id, {
            staleClaimAfterMs: 5 * 60 * 1000,
          })
        )
      );
      expect(results.filter(Boolean).length).toBe(1);
    });
  });

  it("releasePrimaryInvoiceClaim clears the claim so a later attempt can retry", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_release_1" }));
    await claimOrderForPrimaryInvoice(order._id);
    await releasePrimaryInvoiceClaim(order._id);

    const found = await Order.findById(order._id);
    expect(found?.primaryInvoiceClaimedAt).toBeUndefined();
    expect(await claimOrderForPrimaryInvoice(order._id)).toBe(true);
  });

  it("releasePrimaryInvoiceClaim is a no-op once invoiceProvider is set (never undoes a completed invoice)", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_release_2" }));
    await claimOrderForPrimaryInvoice(order._id);
    await recordPrimaryInvoiceForOrder(order._id, {
      invoiceNumber: "TI/2026-27/00001",
      gstRate: 18,
      taxableValue: 1000,
      cgst: 90,
      sgst: 90,
      igst: 0,
      placeOfSupply: "Delhi",
    });

    await releasePrimaryInvoiceClaim(order._id);

    const found = await Order.findById(order._id);
    expect(found?.invoiceProvider).toBe("primary");
    expect(found?.primaryInvoiceClaimedAt).toBeInstanceOf(Date);
  });

  // REGRESSION (2026-09-02, converted 24 Sep 2026): the Zoho self-heal's
  // "stuck order" query once matched a primary-invoiced order and would have
  // issued a SECOND tax invoice for the same payment. The retry list now keys
  // on `invoiceProvider`, so an invoiced order is never listed — including a
  // historical Zoho one, and including one carrying a stale failure flag.
  it("REGRESSION: listFailedInvoiceOrders excludes invoiced orders even with a stale failure flag (no double-billing)", async () => {
    const userId = validUserId();
    const stuck = await createOrder(
      buildOrderPayload({ orderId: "ord_stuck_failed", userId, status: "completed" })
    );
    await markInvoiceCreationFailed(stuck._id, "boom");

    const primaryOrder = await createOrder(
      buildOrderPayload({ orderId: "ord_primary_done", userId, status: "completed" })
    );
    // Stamped BEFORE the invoice landed, then the invoice was recorded.
    await markInvoiceCreationFailed(primaryOrder._id, "first attempt failed");
    await recordPrimaryInvoiceForOrder(primaryOrder._id, {
      invoiceNumber: "TI/2026-27/00009",
      gstRate: 18,
      taxableValue: 1000,
      cgst: 90,
      sgst: 90,
      igst: 0,
      placeOfSupply: "Delhi",
    });

    // Historical Zoho-invoiced order carrying a leftover failure flag written
    // straight to the DB (the service refuses to write one on an invoiced order).
    const zohoOrder = await createOrder(
      buildOrderPayload({ orderId: "ord_zoho_done", userId, status: "completed", invoiceProvider: "zoho" })
    );
    await Order.updateOne({ _id: zohoOrder._id }, { $set: { invoiceFailedAt: new Date() } });

    const ids = (await listFailedInvoiceOrders(String(userId))).map((o) => o.orderId);
    expect(ids).toContain("ord_stuck_failed");
    expect(ids).not.toContain("ord_primary_done");
    expect(ids).not.toContain("ord_zoho_done");
  });

  it("recordPrimaryInvoiceForOrder persists the full GST breakdown + provider", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_record_1" }));
    await claimOrderForPrimaryInvoice(order._id);
    await recordPrimaryInvoiceForOrder(order._id, {
      invoiceNumber: "TI/2026-27/00042",
      gstRate: 18,
      taxableValue: 1000,
      cgst: 0,
      sgst: 0,
      igst: 180,
      placeOfSupply: "Maharashtra",
      customerGstin: "27AAAAA0000A1Z5",
    });

    const found = await Order.findById(order._id);
    expect(found?.invoiceProvider).toBe("primary");
    expect(found?.invoiceNumber).toBe("TI/2026-27/00042");
    expect(found?.taxableValue).toBe(1000);
    expect(found?.igst).toBe(180);
    expect(found?.placeOfSupply).toBe("Maharashtra");
    expect(found?.customerGstin).toBe("27AAAAA0000A1Z5");
  });
});

// ─── Admin invoice listing ────────────────────────────────────────────────────
// Since Zoho Books was removed (24 Sep 2026) our own DB is the only place an
// invoice exists, so the admin list is every order with an `invoiceProvider`:
// primary-engine invoices plus historical Zoho-issued ones.
describe("listInvoiceOrdersAdmin", () => {
  /** Creates a completed order and stamps a primary invoice on it. */
  async function primaryInvoiced(
    orderId: string,
    invoiceNumber: string,
    overrides: Record<string, unknown> = {}
  ) {
    const order = await createOrder(
      buildOrderPayload({ orderId, status: "completed", ...overrides })
    );
    await recordPrimaryInvoiceForOrder(order._id, {
      invoiceNumber,
      gstRate: 18,
      taxableValue: 1000,
      cgst: 90,
      sgst: 90,
      igst: 0,
      placeOfSupply: "Delhi",
    });
    return order;
  }

  it("includes primary AND historical Zoho invoices, but not an order with no invoiceProvider", async () => {
    await primaryInvoiced("ord_admin_primary", "TI/2026-27/00001");
    await createOrder(
      buildOrderPayload({
        orderId: "ord_admin_zoho",
        status: "completed",
        invoiceProvider: "zoho",
        invoiceNumber: "INV-000123",
      })
    );
    // status "completed" makes the pre-save hook mint a legacy invoiceNumber,
    // so this order HAS a number — only the missing invoiceProvider excludes it.
    const legacy = await createOrder(
      buildOrderPayload({ orderId: "ord_admin_uninvoiced", status: "completed" })
    );
    expect((await Order.findById(legacy._id))?.invoiceNumber).toBeTruthy();

    const { orders } = await listInvoiceOrdersAdmin(1, 20);
    const byId = new Map(orders.map((o) => [o.orderId, o]));
    expect(byId.get("ord_admin_primary")?.invoiceProvider).toBe("primary");
    expect(byId.get("ord_admin_zoho")?.invoiceProvider).toBe("zoho");
    expect(byId.has("ord_admin_uninvoiced")).toBe(false);
  });

  it("spans all users — this is the ADMIN view, not a per-customer list", async () => {
    const a = await createOrder(
      buildOrderPayload({ orderId: "ord_u1", userId: validUserId(), status: "completed" })
    );
    const b = await createOrder(
      buildOrderPayload({ orderId: "ord_u2", userId: validUserId(), status: "completed" })
    );
    for (const [o, n] of [[a, "TI/2026-27/00010"], [b, "TI/2026-27/00011"]] as const) {
      await recordPrimaryInvoiceForOrder(o._id, {
        invoiceNumber: n,
        gstRate: 18,
        taxableValue: 1000,
        cgst: 90,
        sgst: 90,
        igst: 0,
        placeOfSupply: "Delhi",
      });
    }
    const { orders } = await listInvoiceOrdersAdmin(1, 20);
    const ids = orders.map((o) => o.orderId);
    expect(ids).toContain("ord_u1");
    expect(ids).toContain("ord_u2");
  });

  it("excludes soft-deleted orders", async () => {
    const order = await primaryInvoiced("ord_deleted", "TI/2026-27/00020");
    await Order.updateOne({ _id: order._id }, { $set: { isDeleted: true } });

    const { orders } = await listInvoiceOrdersAdmin(1, 20);
    expect(orders.map((o) => o.orderId)).not.toContain("ord_deleted");
  });

  it("sorts newest first", async () => {
    await primaryInvoiced("ord_older", "TI/2026-27/00030");
    await primaryInvoiced("ord_newer", "TI/2026-27/00031");
    // Force a deterministic ordering rather than relying on clock resolution.
    await Order.updateOne(
      { orderId: "ord_older" },
      { $set: { createdAt: new Date("2026-01-01T00:00:00Z") } }
    );
    await Order.updateOne(
      { orderId: "ord_newer" },
      { $set: { createdAt: new Date("2026-06-01T00:00:00Z") } }
    );

    const { orders } = await listInvoiceOrdersAdmin(1, 20);
    const ids = orders.map((o) => o.orderId);
    expect(ids.indexOf("ord_newer")).toBeLessThan(ids.indexOf("ord_older"));
  });

  it("**paginates without overlap and reports hasMore correctly**", async () => {
    for (let i = 1; i <= 5; i++) {
      await primaryInvoiced(`ord_page_${i}`, `TI/2026-27/0004${i}`);
      await Order.updateOne(
        { orderId: `ord_page_${i}` },
        { $set: { createdAt: new Date(`2026-0${i}-01T00:00:00Z`) } }
      );
    }

    const p1 = await listInvoiceOrdersAdmin(1, 2);
    const p2 = await listInvoiceOrdersAdmin(2, 2);
    const p3 = await listInvoiceOrdersAdmin(3, 2);

    expect(p1.orders).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    expect(p2.orders).toHaveLength(2);
    expect(p2.hasMore).toBe(true);
    expect(p3.orders).toHaveLength(1);
    // Exactly 5 rows exist, so the last page must NOT claim another one.
    expect(p3.hasMore).toBe(false);

    // No row appears on two pages.
    const all = [...p1.orders, ...p2.orders, ...p3.orders].map((o) => o.orderId);
    expect(new Set(all).size).toBe(5);
  });

  it("never returns the extra look-ahead row it fetches to compute hasMore", async () => {
    for (let i = 1; i <= 3; i++) {
      await primaryInvoiced(`ord_look_${i}`, `TI/2026-27/0005${i}`);
    }
    const { orders, hasMore } = await listInvoiceOrdersAdmin(1, 2);
    expect(orders).toHaveLength(2);
    expect(hasMore).toBe(true);
  });

  it("clamps a garbage page/perPage instead of passing NaN to Mongo", async () => {
    await primaryInvoiced("ord_clamp", "TI/2026-27/00060");
    // NaN would make .skip()/.limit() throw or return nothing.
    const { orders } = await listInvoiceOrdersAdmin(NaN, NaN);
    expect(orders.map((o) => o.orderId)).toContain("ord_clamp");

    const negative = await listInvoiceOrdersAdmin(-5, -5);
    expect(negative.orders.map((o) => o.orderId)).toContain("ord_clamp");
  });

  it("caps perPage at 100 so a hand-crafted request can't pull the whole collection", async () => {
    await primaryInvoiced("ord_cap", "TI/2026-27/00070");
    const { orders } = await listInvoiceOrdersAdmin(1, 100000);
    // Can't assert the limit directly through the public API; assert it still
    // returns correctly and doesn't throw, and that the page is bounded.
    expect(orders.length).toBeLessThanOrEqual(100);
  });

  it("selects the fields the admin row needs (invoice number, customer, amount)", async () => {
    // buildOrderPayload leaves the customer fields unset, so they're supplied
    // here — otherwise the assertion would pass vacuously whether or not the
    // projection actually includes them.
    await primaryInvoiced("ord_fields", "TI/2026-27/00080", {
      userName: "Alice Anderson",
      userEmail: "alice@example.com",
    });
    const { orders } = await listInvoiceOrdersAdmin(1, 20);
    const row = orders.find((o) => o.orderId === "ord_fields")!;
    expect(row.invoiceNumber).toBe("TI/2026-27/00080");
    expect(row.userName).toBe("Alice Anderson");
    expect(row.userEmail).toBe("alice@example.com");
    expect(row.amount).toBe(1000);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("does NOT leak fields outside the projection (e.g. razorpaySignature)", async () => {
    await primaryInvoiced("ord_proj", "TI/2026-27/00090");
    const { orders } = await listInvoiceOrdersAdmin(1, 20);
    const row = orders.find((o) => o.orderId === "ord_proj")! as unknown as Record<string, unknown>;
    expect(row.razorpaySignature).toBeUndefined();
    expect(row.paymentVerification).toBeUndefined();
  });

  it("returns an empty page rather than throwing when nothing is invoiced", async () => {
    await createOrder(buildOrderPayload({ orderId: "ord_none", status: "completed" }));
    const { orders, hasMore } = await listInvoiceOrdersAdmin(1, 20);
    expect(orders).toEqual([]);
    expect(hasMore).toBe(false);
  });
});

// ─── Manual credit-note obligation (Primary Billing Integration) ──────────────
// The primary GST engine has no credit-note counterpart (deferred by operator
// decision 2026-09-03), so a refund against a primary invoice leaves a real
// statutory obligation that an operator discharges by hand.
// These helpers make that obligation queryable rather than log-only.
describe("flagCreditNotePending / listCreditNotePendingOrders", () => {
  async function primaryInvoicedOrder(orderId: string, invoiceNumber: string) {
    const order = await createOrder(
      buildOrderPayload({ orderId, status: "completed", userEmail: "a@x.test" })
    );
    await recordPrimaryInvoiceForOrder(order._id, {
      invoiceNumber,
      gstRate: 18,
      taxableValue: 1000,
      cgst: 90,
      sgst: 90,
      igst: 0,
      placeOfSupply: "Delhi",
    });
    return order;
  }

  it("stamps the obligation with the refund id, amount in paise and a timestamp", async () => {
    const order = await primaryInvoicedOrder("ord_cn_1", "TI/2026-27/00001");
    await flagCreditNotePending(order._id, {
      refundId: "rfnd_1",
      refundAmountPaise: 118000,
    });

    const found = await Order.findById(order._id);
    expect(found?.creditNotePending).toBe(true);
    expect(found?.creditNotePendingRefundId).toBe("rfnd_1");
    // Paise, deliberately unconverted, so it matches the Razorpay record the
    // operator is looking at.
    expect(found?.creditNotePendingAmountPaise).toBe(118000);
    expect(found?.creditNotePendingAt).toBeInstanceOf(Date);
  });

  it("**is idempotent for the SAME refund id** — a redelivered webhook must not reset how long the obligation has been outstanding", async () => {
    const order = await primaryInvoicedOrder("ord_cn_2", "TI/2026-27/00002");
    await flagCreditNotePending(order._id, {
      refundId: "rfnd_dup",
      refundAmountPaise: 5000,
    });
    const first = (await Order.findById(order._id))?.creditNotePendingAt;

    await new Promise((r) => setTimeout(r, 5));
    await flagCreditNotePending(order._id, {
      refundId: "rfnd_dup",
      refundAmountPaise: 5000,
    });

    const second = (await Order.findById(order._id))?.creditNotePendingAt;
    expect(second!.getTime()).toBe(first!.getTime());
  });

  it("a DIFFERENT refund id overwrites — a second partial refund is a fresh obligation", async () => {
    const order = await primaryInvoicedOrder("ord_cn_3", "TI/2026-27/00003");
    await flagCreditNotePending(order._id, {
      refundId: "rfnd_a",
      refundAmountPaise: 5000,
    });
    await flagCreditNotePending(order._id, {
      refundId: "rfnd_b",
      refundAmountPaise: 7000,
    });

    const found = await Order.findById(order._id);
    expect(found?.creditNotePendingRefundId).toBe("rfnd_b");
    expect(found?.creditNotePendingAmountPaise).toBe(7000);
  });

  it("lists only flagged orders", async () => {
    const flagged = await primaryInvoicedOrder("ord_cn_listed", "TI/2026-27/00010");
    await primaryInvoicedOrder("ord_cn_clean", "TI/2026-27/00011");
    await flagCreditNotePending(flagged._id, {
      refundId: "rfnd_l",
      refundAmountPaise: 1000,
    });

    const rows = await listCreditNotePendingOrders();
    const ids = rows.map((o) => o.orderId);
    expect(ids).toContain("ord_cn_listed");
    expect(ids).not.toContain("ord_cn_clean");
  });

  it("**lists OLDEST first** — the longest-outstanding obligation is the most urgent (GST credit notes are due by 30 Nov following the FY end)", async () => {
    const older = await primaryInvoicedOrder("ord_cn_older", "TI/2026-27/00020");
    const newer = await primaryInvoicedOrder("ord_cn_newer", "TI/2026-27/00021");
    await flagCreditNotePending(older._id, { refundId: "r1", refundAmountPaise: 100 });
    await flagCreditNotePending(newer._id, { refundId: "r2", refundAmountPaise: 100 });
    await Order.updateOne(
      { _id: older._id },
      { $set: { creditNotePendingAt: new Date("2026-01-01T00:00:00Z") } }
    );
    await Order.updateOne(
      { _id: newer._id },
      { $set: { creditNotePendingAt: new Date("2026-08-01T00:00:00Z") } }
    );

    const ids = (await listCreditNotePendingOrders()).map((o) => o.orderId);
    expect(ids.indexOf("ord_cn_older")).toBeLessThan(ids.indexOf("ord_cn_newer"));
  });

  it("excludes soft-deleted orders", async () => {
    const order = await primaryInvoicedOrder("ord_cn_deleted", "TI/2026-27/00030");
    await flagCreditNotePending(order._id, { refundId: "r", refundAmountPaise: 100 });
    await Order.updateOne({ _id: order._id }, { $set: { isDeleted: true } });

    const ids = (await listCreditNotePendingOrders()).map((o) => o.orderId);
    expect(ids).not.toContain("ord_cn_deleted");
  });

  it("carries the fields the admin report renders (invoice number, refund id, amount, email)", async () => {
    const order = await primaryInvoicedOrder("ord_cn_fields", "TI/2026-27/00040");
    await flagCreditNotePending(order._id, {
      refundId: "rfnd_f",
      refundAmountPaise: 24600,
    });

    const row = (await listCreditNotePendingOrders()).find(
      (o) => o.orderId === "ord_cn_fields"
    )!;
    expect(row.invoiceNumber).toBe("TI/2026-27/00040");
    expect(row.invoiceProvider).toBe("primary");
    expect(row.creditNotePendingRefundId).toBe("rfnd_f");
    expect(row.creditNotePendingAmountPaise).toBe(24600);
    expect(row.userEmail).toBe("a@x.test");
  });

  it("clearing the flag removes it from the report — an operator who raised the credit note stops being nagged", async () => {
    const order = await primaryInvoicedOrder("ord_cn_cleared", "TI/2026-27/00050");
    await flagCreditNotePending(order._id, { refundId: "r", refundAmountPaise: 100 });
    await Order.updateOne(
      { _id: order._id },
      { $set: { creditNotePending: false } }
    );

    const ids = (await listCreditNotePendingOrders()).map((o) => o.orderId);
    expect(ids).not.toContain("ord_cn_cleared");
  });

  it("returns an empty list rather than throwing when nothing is outstanding", async () => {
    await primaryInvoicedOrder("ord_cn_none", "TI/2026-27/00060");
    expect(await listCreditNotePendingOrders()).toEqual([]);
  });
});

// ─── Admin order lookup: _id vs user-facing orderId ─────────────────────────
//
// REGRESSION (2026-09-03). `app/api/admin/orders/[id]/invoice` used
// `getOrderById`, i.e. `Order.findById()` ONLY. That is fine for a 24-hex
// `_id` and throws a Mongoose CastError for anything else — which the route's
// catch turned into a 500.
//
// It became reachable when the admin invoices page grew its GST-engine tab:
// a primary-engine invoice has no Zoho id, so its View/Download link by the
// user-facing `orderId` string (e.g. `ORD-RNW-…`), and every one 500'd. Found
// by driving the real admin UI in a browser — the page's component tests mock
// the fetch, so they could not see it.
//
// These tests pin the actual mechanism, against a real database, so the
// distinction can't be lost again.
describe("getOrderById vs getOrderByIdOrOrderId (admin PDF route regression)", () => {
  it("**getOrderById THROWS on a user-facing orderId** — this was the 500", async () => {
    await createOrder(buildOrderPayload({ orderId: "ORD-RNW-1757000000-abcd" }));
    await expect(getOrderById("ORD-RNW-1757000000-abcd")).rejects.toThrow();
  });

  it("**getOrderByIdOrOrderId resolves the same string** — the fix", async () => {
    const created = await createOrder(
      buildOrderPayload({ orderId: "ORD-RNW-1757000000-efgh" })
    );
    const found = await getOrderByIdOrOrderId("ORD-RNW-1757000000-efgh");
    expect(found).not.toBeNull();
    expect(String(found!._id)).toBe(String(created._id));
  });

  it("both resolve a 24-hex _id, so the swap loses nothing", async () => {
    const created = await createOrder(buildOrderPayload({ orderId: "ORD-hex-1" }));
    const byId = await getOrderById(String(created._id));
    const byEither = await getOrderByIdOrOrderId(String(created._id));
    expect(byId?.orderId).toBe("ORD-hex-1");
    expect(byEither?.orderId).toBe("ORD-hex-1");
  });

  it("a primary-invoiced order is reachable by its orderId — the exact shape the GST tab links", async () => {
    const created = await createOrder(
      buildOrderPayload({ orderId: "ORD-primary-ui", status: "completed" })
    );
    await recordPrimaryInvoiceForOrder(created._id, {
      invoiceNumber: "TI/2026-27/00001",
      gstRate: 18,
      taxableValue: 1000,
      cgst: 0,
      sgst: 0,
      igst: 180,
      placeOfSupply: "Maharashtra",
    });

    const found = await getOrderByIdOrOrderId("ORD-primary-ui");
    expect(found?.invoiceProvider).toBe("primary");
    expect(found?.invoiceNumber).toBe("TI/2026-27/00001");
  });
});
