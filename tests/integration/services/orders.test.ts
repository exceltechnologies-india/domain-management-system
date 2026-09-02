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
  claimOrderForZohoInvoice,
  claimPendingOrderForProcessing,
  clearOrderInvoiceNumber,
  createOrder,
  findOrderByDomain,
  findOrderByDomainForUser,
  findOrderByRazorpayPaymentField,
  findOrderByZohoInvoiceForUser,
  findPriorHostingOrderForUser,
  forceMarkZohoCreationFailed,
  getOrderByIdOrOrderId,
  getOrderByOrderId,
  getOrderByRazorpayOrderId,
  listAllOrdersForAdminDomains,
  listOrdersByRazorpayPaymentIds,
  listOrdersForUser,
  listRecentCompletedOrdersForUser,
  listStuckCompletedOrders,
  listUserInvoiceOrders,
  recordPrimaryInvoiceForOrder,
  recordZohoInvoiceForOrder,
  releasePrimaryInvoiceClaim,
  releaseZohoInvoiceClaim,
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

describe("findOrderByZohoInvoiceForUser", () => {
  it("scopes by userId AND zohoInvoiceId, filtering soft-deletes", async () => {
    const owner = validUserId();
    const other = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_zoho_1",
        userId: owner,
        zohoInvoiceId: "ZH-001",
      })
    );

    expect((await findOrderByZohoInvoiceForUser(owner, "ZH-001"))?.orderId).toBe("ord_zoho_1");
    // Wrong user — must be 404-equivalent.
    expect(await findOrderByZohoInvoiceForUser(other, "ZH-001")).toBeNull();
  });

  it("honours the select option", async () => {
    const owner = validUserId();
    await createOrder(
      buildOrderPayload({
        orderId: "ord_zoho_2",
        userId: owner,
        zohoInvoiceId: "ZH-002",
      })
    );
    const projected = await findOrderByZohoInvoiceForUser(owner, "ZH-002", {
      select: "_id zohoInvoiceId",
    });
    // `orderId` was not selected — should be undefined on the projection.
    expect(projected?.zohoInvoiceId).toBe("ZH-002");
    expect(projected?.orderId).toBeUndefined();
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

describe("Zoho-invoice claim lifecycle", () => {
  it("claim → record → reject second claim", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_claim_1" }));

    const claimed = await claimOrderForZohoInvoice(order._id, { allowNull: true });
    expect(claimed?.zohoInvoiceId).toBe("pending_creation");

    const second = await claimOrderForZohoInvoice(order._id, { allowNull: true });
    // Second claim must fail — first worker holds it.
    expect(second).toBeNull();

    await recordZohoInvoiceForOrder(order._id, {
      invoiceId: "ZH-real-001",
      invoiceNumber: "INV-real-001",
    });

    const refetched = await Order.findById(order._id);
    expect(refetched?.zohoInvoiceId).toBe("ZH-real-001");
    expect(refetched?.invoiceNumber).toBe("INV-real-001");
  });

  it("releaseZohoInvoiceClaim clears pending_creation but no-ops otherwise", async () => {
    const order = await createOrder(buildOrderPayload({ orderId: "ord_release_1" }));
    await claimOrderForZohoInvoice(order._id, { allowNull: true });
    await releaseZohoInvoiceClaim(order._id);
    const refetched = await Order.findById(order._id);
    expect(refetched?.zohoInvoiceId).toBeUndefined();

    // No-op when not in pending_creation state.
    await recordZohoInvoiceForOrder(order._id, { invoiceId: "ZH-final" });
    await releaseZohoInvoiceClaim(order._id);
    const after = await Order.findById(order._id);
    expect(after?.zohoInvoiceId).toBe("ZH-final");
  });

  it("forceMarkZohoCreationFailed stamps creation_failed regardless of prior state", async () => {
    const order = await createOrder(
      buildOrderPayload({ orderId: "ord_force_1", zohoInvoiceId: "ZH-was-set" })
    );
    await forceMarkZohoCreationFailed(order._id);
    const refetched = await Order.findById(order._id);
    expect(refetched?.zohoInvoiceId).toBe("creation_failed");
  });

  it("recordZohoInvoiceForOrder swallows E11000 invoice-number collision but still stores invoiceId", async () => {
    const ordA = await createOrder(
      buildOrderPayload({ orderId: "ord_dup_a", invoiceNumber: "INV-DUP" })
    );
    const ordB = await createOrder(buildOrderPayload({ orderId: "ord_dup_b" }));

    // Order B tries to claim the same invoiceNumber — the unique index will
    // reject it on the `{$set: {invoiceNumber}}` path. The helper must catch
    // the dupe and fall back to storing zohoInvoiceId only.
    await expect(
      recordZohoInvoiceForOrder(ordB._id, {
        invoiceId: "ZH-shared",
        invoiceNumber: "INV-DUP",
      })
    ).resolves.toBeUndefined();

    const refetched = await Order.findById(ordB._id);
    expect(refetched?.zohoInvoiceId).toBe("ZH-shared");
    expect(refetched?.invoiceNumber).toBeUndefined();
    // Order A still owns the invoiceNumber.
    const refetchedA = await Order.findById(ordA._id);
    expect(refetchedA?.invoiceNumber).toBe("INV-DUP");
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
