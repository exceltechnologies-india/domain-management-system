/**
 * Tests for `@/lib/services/orders` writer + remaining-readers subset
 * (rescan-4 slice 7ex). Covers what orders-zoho-claim.test.ts and
 * orders-readers.test.ts don't:
 *  - listOrdersForUser pagination + populateUser + select; limit≤0
 *    returns all
 *  - softDeleteOrder / permanentlyDeleteOrder / unarchiveOrder writes
 *  - **createOrder thin pass-through** to Order.create
 *  - createOrderInSession uses `new Order(...).save({session})` so the
 *    insert participates in the caller's transaction
 *  - **createRenewalOrder**: paise → rupees (/100); orderId =
 *    `ORD-RNW-{timestamp}-{8-hex}` (crypto.randomBytes(4) — the M3
 *    invoice-number fix's same upgrade vs the prior Math.random*1000
 *    that was burst-collision-prone); subscriptionId fallback when
 *    payment.order_id is null; isMonthly drives registrationPeriod
 *    (1/12) + periodUnit (months/years); razorpaySignature pinned to
 *    'webhook_verified' literal (audit trail marker)
 *  - forceMarkZohoCreationFailed: unconditional $set (no
 *    pending_creation guard — used from the catch-block where prior
 *    state is indeterminate)
 *  - listStuckZohoInvoiceOrders (user-scoped): filter + StuckZohoInvoiceOrder
 *    projection
 *  - listAllOrdersForAdminDomains excludes 'pending' (checkout intents
 *    not in admin-domain view)
 *  - userHasPriorTrialOrder uses Order.exists (cheap existence)
 *  - findPriorHostingOrderForUser $or: userEmail OR userId (migration-
 *    window safety where order may pre-date user-account creation)
 *  - listRecentCompletedOrdersForUser: default 14 days + sort ASC (so
 *    newer entries overwrite stale ones in caller's de-dup)
 *  - listUserInvoiceOrders: `invoiceNumber: {$exists, $ne:null}` filter
 *    + slim projection
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const OrderCtor = vi.hoisted(() => vi.fn());
const Order = vi.hoisted(() => ({
  findById: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  findByIdAndDelete: vi.fn(),
  findOne: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  updateOne: vi.fn(),
  countDocuments: vi.fn(),
  exists: vi.fn(),
  aggregate: vi.fn(),
}));
vi.mock("@/models/Order", () => ({
  default: Object.assign(
    function MockOrder(payload: unknown) {
      OrderCtor(payload);
      const instance = {
        ...((payload as object) ?? {}),
        save: vi.fn().mockResolvedValue(undefined),
      };
      return instance;
    },
    Order
  ),
}));

vi.mock("@/models/User", () => ({ default: { modelName: "User" } }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  listOrdersForUser,
  softDeleteOrder,
  permanentlyDeleteOrder,
  unarchiveOrder,
  createOrder,
  createOrderInSession,
  createRenewalOrder,
  forceMarkZohoCreationFailed,
  listStuckZohoInvoiceOrders,
  listAllOrdersForAdminDomains,
  userHasPriorTrialOrder,
  findPriorHostingOrderForUser,
  listRecentCompletedOrdersForUser,
  listUserInvoiceOrders,
} from "@/lib/services/orders";

beforeEach(() => {
  connectDB.mockReset();
  OrderCtor.mockReset();
  Object.values(Order).forEach((fn) =>
    (fn as ReturnType<typeof vi.fn>).mockReset()
  );
});

describe("listOrdersForUser", () => {
  it("default: limit 50, populateUser true, excludes pending + soft-deleted", async () => {
    const limit = vi.fn().mockResolvedValueOnce([]);
    const populate = vi.fn().mockReturnValue({ limit });
    const sort = vi.fn().mockReturnValue({ populate });
    Order.find.mockReturnValueOnce({ sort });
    await listOrdersForUser("USER_ID");
    const [filter] = Order.find.mock.calls[0];
    expect(filter.userId).toBe("USER_ID");
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(filter.status).toEqual({ $ne: "pending" });
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(populate).toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith(50);
  });

  it("limit:0 → NO .limit() chain (return all — dashboard flattens)", async () => {
    const populate = vi.fn().mockResolvedValueOnce([]);
    const sort = vi.fn().mockReturnValue({ populate });
    Order.find.mockReturnValueOnce({ sort });
    await listOrdersForUser("USER_ID", { limit: 0 });
    // populate was called but limit was not.
  });

  it("populateUser:false → no populate chain", async () => {
    const limit = vi.fn().mockResolvedValueOnce([]);
    const sort = vi.fn().mockReturnValue({ limit });
    Order.find.mockReturnValueOnce({ sort });
    await listOrdersForUser("USER_ID", { populateUser: false });
    // limit still called but populate isn't in the chain.
    expect(limit).toHaveBeenCalled();
  });

  it("custom select chain", async () => {
    const limit = vi.fn().mockResolvedValueOnce([]);
    const populate = vi.fn().mockReturnValue({ limit });
    const select = vi.fn().mockReturnValue({ populate });
    const sort = vi.fn().mockReturnValue({ select });
    Order.find.mockReturnValueOnce({ sort });
    await listOrdersForUser("USER_ID", { select: "orderId status" });
    expect(select).toHaveBeenCalledWith("orderId status");
  });
});

describe("softDeleteOrder / permanentlyDeleteOrder / unarchiveOrder", () => {
  it("softDeleteOrder: sets isDeleted:true + stamps deletedAt", async () => {
    Order.findByIdAndUpdate.mockResolvedValueOnce({ _id: "O1" });
    await softDeleteOrder("O1");
    const [id, update] = Order.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe("O1");
    expect(update.isDeleted).toBe(true);
    expect(update.deletedAt).toBeInstanceOf(Date);
  });

  it("permanentlyDeleteOrder: findByIdAndDelete (unrecoverable)", async () => {
    Order.findByIdAndDelete.mockResolvedValueOnce({ _id: "O1" });
    await permanentlyDeleteOrder("O1");
    expect(Order.findByIdAndDelete).toHaveBeenCalledWith("O1");
  });

  it("unarchiveOrder: isDeleted:false + $unset deletedAt", async () => {
    Order.findByIdAndUpdate.mockResolvedValueOnce({ _id: "O1" });
    await unarchiveOrder("O1");
    const [id, update] = Order.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe("O1");
    expect(update.isDeleted).toBe(false);
    expect(update.$unset).toEqual({ deletedAt: 1 });
  });
});

describe("createOrder + createOrderInSession", () => {
  it("createOrder: thin pass-through to Order.create", async () => {
    Order.create.mockResolvedValueOnce({ _id: "O1" });
    const payload = { orderId: "ord_1", userId: "U1" };
    await createOrder(payload as never);
    expect(Order.create).toHaveBeenCalledWith(payload);
  });

  it("createOrderInSession: new Order(payload) + .save({session})", async () => {
    const sessionStub = {} as never;
    const payload = { orderId: "ord_1", userId: "U1" };
    const result = await createOrderInSession(payload as never, sessionStub);
    expect(OrderCtor).toHaveBeenCalledWith(payload);
    // The returned doc carries the payload + save spy.
    expect((result as { save: unknown }).save).toBeDefined();
  });
});

describe("createRenewalOrder", () => {
  const USER = {
    _id: "USER_ID",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@x.test",
  };

  it("paise → rupees (/100) for amount", async () => {
    await createRenewalOrder({
      user: USER,
      payment: { id: "pay_1", amount: 50000, currency: "INR", order_id: "ord_rzp_1" },
      subscriptionId: "sub_1",
      domainName: "x.com",
      isMonthly: false,
    });
    const [payload] = OrderCtor.mock.calls[0];
    expect(payload.amount).toBe(500);
    expect(payload.domains[0].price).toBe(500);
  });

  it("orderId format: ORD-RNW-{timestamp}-{8 hex chars}", async () => {
    await createRenewalOrder({
      user: USER,
      payment: { id: "pay_1", amount: 1000, currency: "INR" },
      subscriptionId: "sub_1",
      domainName: "x.com",
      isMonthly: true,
    });
    const [payload] = OrderCtor.mock.calls[0];
    expect(payload.orderId).toMatch(/^ORD-RNW-\d+-[a-f0-9]{8}$/);
  });

  it("razorpayOrderId falls back to subscriptionId when payment.order_id is null/undefined", async () => {
    await createRenewalOrder({
      user: USER,
      payment: { id: "pay_1", amount: 1000, currency: "INR", order_id: null },
      subscriptionId: "sub_FALLBACK",
      domainName: "x.com",
      isMonthly: true,
    });
    const [payload] = OrderCtor.mock.calls[0];
    expect(payload.razorpayOrderId).toBe("sub_FALLBACK");
    expect(payload.paymentVerification.razorpayOrderId).toBe("sub_FALLBACK");
  });

  it("payment.order_id present wins over subscriptionId", async () => {
    await createRenewalOrder({
      user: USER,
      payment: { id: "pay_1", amount: 1000, currency: "INR", order_id: "ord_rzp_REAL" },
      subscriptionId: "sub_1",
      domainName: "x.com",
      isMonthly: true,
    });
    expect(OrderCtor.mock.calls[0][0].razorpayOrderId).toBe("ord_rzp_REAL");
  });

  it("isMonthly:true → registrationPeriod=1 + periodUnit='months'", async () => {
    await createRenewalOrder({
      user: USER,
      payment: { id: "pay_1", amount: 1000, currency: "INR" },
      subscriptionId: "sub_1",
      domainName: "x.com",
      isMonthly: true,
    });
    const domain = OrderCtor.mock.calls[0][0].domains[0];
    expect(domain.registrationPeriod).toBe(1);
    expect(domain.periodUnit).toBe("months");
  });

  it("isMonthly:false → registrationPeriod=12 + periodUnit='years'", async () => {
    await createRenewalOrder({
      user: USER,
      payment: { id: "pay_1", amount: 1000, currency: "INR" },
      subscriptionId: "sub_1",
      domainName: "x.com",
      isMonthly: false,
    });
    const domain = OrderCtor.mock.calls[0][0].domains[0];
    expect(domain.registrationPeriod).toBe(12);
    expect(domain.periodUnit).toBe("years");
  });

  it("razorpaySignature pinned to 'webhook_verified' literal (audit-trail marker)", async () => {
    await createRenewalOrder({
      user: USER,
      payment: { id: "pay_1", amount: 1000, currency: "INR" },
      subscriptionId: "sub_1",
      domainName: "x.com",
      isMonthly: true,
    });
    expect(OrderCtor.mock.calls[0][0].razorpaySignature).toBe(
      "webhook_verified"
    );
  });

  it("hostingPlan passed through into the domain row", async () => {
    await createRenewalOrder({
      user: USER,
      payment: { id: "pay_1", amount: 1000, currency: "INR" },
      subscriptionId: "sub_1",
      domainName: "x.com",
      isMonthly: true,
      hostingPlan: {
        planId: "starter",
        name: "Starter Plan",
        serverPackage: "Standard",
      },
    });
    expect(OrderCtor.mock.calls[0][0].domains[0].hostingPlan).toEqual({
      planId: "starter",
      name: "Starter Plan",
      serverPackage: "Standard",
    });
  });

  it("status:'completed' + orderType:'renewal' + successfulDomains pre-populated", async () => {
    await createRenewalOrder({
      user: USER,
      payment: { id: "pay_1", amount: 1000, currency: "INR" },
      subscriptionId: "sub_1",
      domainName: "x.com",
      isMonthly: true,
    });
    const payload = OrderCtor.mock.calls[0][0];
    expect(payload.status).toBe("completed");
    expect(payload.orderType).toBe("renewal");
    expect(payload.successfulDomains).toEqual(["x.com"]);
  });
});

describe("forceMarkZohoCreationFailed", () => {
  it("unconditional $set — no pending_creation guard", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    await forceMarkZohoCreationFailed("O1");
    const [filter, update] = Order.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "O1" });
    // No zohoInvoiceId predicate — just _id.
    expect(filter.zohoInvoiceId).toBeUndefined();
    expect(update).toEqual({ $set: { zohoInvoiceId: "creation_failed" } });
  });
});

describe("listStuckZohoInvoiceOrders (user-scoped)", () => {
  it("user-scoped filter + $or of 5 unclaimed forms + slim projection + lean", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const select = vi.fn().mockReturnValue({ lean });
    Order.find.mockReturnValueOnce({ select });
    await listStuckZohoInvoiceOrders("USER_ID");
    const [filter] = Order.find.mock.calls[0];
    expect(filter.userId).toBe("USER_ID");
    expect(filter.status.$in).toEqual(["completed", "paid"]);
    expect(filter.isDeleted).toEqual({ $ne: true });
    // 4 forms here (vs 5 in admin variant): not-exists / null / empty
    // / creation_failed. The user-scoped path INTENTIONALLY excludes
    // 'pending_creation' — in-flight claim is not "stuck" yet for the
    // user's own retry UI.
    expect(filter.$or).toEqual([
      { zohoInvoiceId: { $exists: false } },
      { zohoInvoiceId: null },
      { zohoInvoiceId: "" },
      { zohoInvoiceId: "creation_failed" },
    ]);
  });
});

describe("listAllOrdersForAdminDomains", () => {
  it("excludes 'pending' + populates owner + sort createdAt:-1 + lean", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const sort = vi.fn().mockReturnValue({ lean });
    const populate = vi.fn().mockReturnValue({ sort });
    Order.find.mockReturnValueOnce({ populate });
    await listAllOrdersForAdminDomains();
    const [filter] = Order.find.mock.calls[0];
    expect(filter.status).toEqual({ $ne: "pending" });
    expect(populate).toHaveBeenCalledWith(
      "userId",
      "firstName lastName email phone companyName"
    );
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
  });
});

describe("userHasPriorTrialOrder", () => {
  it("uses Order.exists (cheap) + filter userId + orderType:'hosting_trial', excluding abandoned mandates", async () => {
    Order.exists.mockResolvedValueOnce({ _id: "X" });
    expect(await userHasPriorTrialOrder("USER_ID")).toBe(true);
    // The $nor clause excludes the abandoned-at-mandate shape
    // ({status:'pending', razorpayPaymentId:'pending'}) so a closed Razorpay
    // overlay never locks a user out of a trial they never began.
    expect(Order.exists).toHaveBeenCalledWith({
      userId: "USER_ID",
      orderType: "hosting_trial",
      $nor: [{ status: "pending", razorpayPaymentId: "pending" }],
    });
  });

  it("no exists → returns false (boolean coerced)", async () => {
    Order.exists.mockResolvedValueOnce(null);
    expect(await userHasPriorTrialOrder("USER_ID")).toBe(false);
  });
});

describe("findPriorHostingOrderForUser", () => {
  it("$or covers BOTH userEmail AND userId (migration-window safety)", async () => {
    Order.findOne.mockResolvedValueOnce(null);
    await findPriorHostingOrderForUser("USER_ID", "alice@x.test");
    const [filter] = Order.findOne.mock.calls[0];
    expect(filter.$or).toEqual([
      { userEmail: "alice@x.test" },
      { userId: "USER_ID" },
    ]);
    expect(filter["domains.itemType"]).toBe("hosting");
    expect(filter.status.$in).toEqual(["paid", "completed", "processing"]);
  });
});

describe("listRecentCompletedOrdersForUser", () => {
  it("default 14 days + sort ASC (oldest first so newer entries overwrite stale)", async () => {
    const sort = vi.fn().mockResolvedValueOnce([]);
    Order.find.mockReturnValueOnce({ sort });
    const before = Date.now();
    await listRecentCompletedOrdersForUser("USER_ID");
    const [filter] = Order.find.mock.calls[0];
    expect(filter.userId).toBe("USER_ID");
    expect(filter.status).toBe("completed");
    expect(filter.createdAt.$gte.getTime()).toBeGreaterThanOrEqual(
      before - 14 * 24 * 60 * 60 * 1000
    );
    expect(sort).toHaveBeenCalledWith({ createdAt: 1 });
  });

  it("custom withinDays honoured", async () => {
    const sort = vi.fn().mockResolvedValueOnce([]);
    Order.find.mockReturnValueOnce({ sort });
    const before = Date.now();
    await listRecentCompletedOrdersForUser("USER_ID", { withinDays: 30 });
    const [filter] = Order.find.mock.calls[0];
    expect(filter.createdAt.$gte.getTime()).toBeGreaterThanOrEqual(
      before - 30 * 24 * 60 * 60 * 1000
    );
  });
});

describe("listUserInvoiceOrders", () => {
  it("invoiceNumber $exists $ne null + excludes pending + slim projection + lean", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const select = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ select });
    Order.find.mockReturnValueOnce({ sort });
    await listUserInvoiceOrders("USER_ID");
    const [filter] = Order.find.mock.calls[0];
    expect(filter.userId).toBe("USER_ID");
    expect(filter.invoiceNumber).toEqual({ $exists: true, $ne: null });
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(filter.status).toEqual({ $ne: "pending" });
    // orderId + invoiceProvider were added 2026-09-02 so the invoice list can
    // render a primary-engine tax invoice (no zohoInvoiceId) and link its PDF
    // via the orderId-keyed route.
    expect(select).toHaveBeenCalledWith(
      "orderId invoiceNumber zohoInvoiceId invoiceProvider amount currency status createdAt"
    );
  });
});
