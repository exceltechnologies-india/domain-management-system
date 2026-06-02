/**
 * Tests for `@/lib/services/orders` reader/finder helpers + 3 pure
 * helpers (rescan-4 slice 7ew). Picks up everything NOT covered by
 * orders-zoho-claim.test.ts. Pins:
 *  - **getOrderByIdOrOrderId branches on 24-hex regex** (not $or) —
 *    the docs explicitly call out the latent footgun where a hex
 *    string that happens to equal an orderId could match the wrong row
 *  - findUserOrder uses ObjectId.isValid branch + ALWAYS scopes by
 *    userId + filters out isDeleted (privacy-safe — returns null for
 *    other-user rows so the route returns 404)
 *  - listStuckCompletedOrders: cutoff = Date.now() - staleAfterMs +
 *    `domains.status: pending` filter
 *  - findInvoiceNumberConflicts: aggregation pipeline pinned
 *    ($match-exists → $group-by-number → $match count>1 → $sort
 *    desc → $limit 100)
 *  - listOrdersByIds short-circuits on empty array (no Mongo round trip)
 *  - listStuckZohoInvoiceOrdersAdmin: $or 5 unclaimed forms + sort
 *    createdAt:-1 + default limit 100
 *  - listOrdersForAdmin pagination: page>=1, perPage>=1, skip arithmetic;
 *    archived flag flips isDeleted filter; includePending default false
 *    excludes 'pending' (checkout intents); **HARD-DELETED-USER fallback**
 *    synthesises a userId stub from userName/userEmail snapshot when the
 *    populated User row is null
 *  - hasMore = skip + orders.length < total
 *  - Pure helpers: findOrderDomain (===), mapOrderDomains, filterOrderDomainsByName
 *    (Set-membership)
 *  - findOrderByDomainForUser ALWAYS includes userId + isDeleted filter
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const Order = vi.hoisted(() => ({
  findById: vi.fn(),
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  countDocuments: vi.fn(),
  aggregate: vi.fn(),
}));
vi.mock("@/models/Order", () => ({ default: Order }));

vi.mock("@/models/User", () => ({ default: { modelName: "User" } }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  getOrderById,
  getOrderByOrderId,
  getOrderByIdOrOrderId,
  listStuckCompletedOrders,
  findInvoiceNumberConflicts,
  listOrdersByIds,
  listStuckZohoInvoiceOrdersAdmin,
  listOrdersWithInFlightDomains,
  countAllOrders,
  listOrdersByRazorpayPaymentIds,
  clearOrderInvoiceNumber,
  getOrderByRazorpayPaymentId,
  findOrderByRazorpayOrderIdOrInternalId,
  getOrderByRazorpayOrderId,
  findUserOrder,
  listOrdersForAdmin,
  findOrderDomain,
  mapOrderDomains,
  filterOrderDomainsByName,
  findOrderByDomainForUser,
  findOrderByDomain,
  findOrdersByDomainName,
} from "@/lib/services/orders";

beforeEach(() => {
  connectDB.mockReset();
  Object.values(Order).forEach((fn) =>
    (fn as ReturnType<typeof vi.fn>).mockReset()
  );
});

describe("getOrderById / getOrderByOrderId", () => {
  it("getOrderById uses findById", async () => {
    Order.findById.mockResolvedValueOnce({ _id: "O1" });
    await getOrderById("O1");
    expect(Order.findById).toHaveBeenCalledWith("O1");
  });

  it("getOrderByOrderId uses findOne({orderId}) + optional populate", async () => {
    const populate = vi.fn().mockResolvedValueOnce({ _id: "O1" });
    Order.findOne.mockReturnValueOnce({ populate });
    await getOrderByOrderId("ord_42", {
      populate: { path: "userId", select: "firstName email" },
    });
    expect(Order.findOne).toHaveBeenCalledWith({ orderId: "ord_42" });
    expect(populate).toHaveBeenCalledWith("userId", "firstName email");
  });
});

describe("getOrderByIdOrOrderId — 24-hex regex branch (NOT $or)", () => {
  it("24-hex input → filter by _id ONLY (not orderId)", async () => {
    Order.findOne.mockResolvedValueOnce({ _id: "X" });
    await getOrderByIdOrOrderId("507f1f77bcf86cd799439011");
    expect(Order.findOne).toHaveBeenCalledWith({
      _id: "507f1f77bcf86cd799439011",
    });
  });

  it("non-hex input → filter by orderId ONLY", async () => {
    Order.findOne.mockResolvedValueOnce({ _id: "X" });
    await getOrderByIdOrOrderId("ord_42");
    expect(Order.findOne).toHaveBeenCalledWith({ orderId: "ord_42" });
  });

  it("select projection: applied via .select() chain", async () => {
    const select = vi.fn().mockResolvedValueOnce({ _id: "X" });
    Order.findOne.mockReturnValueOnce({ select });
    await getOrderByIdOrOrderId("ord_42", { select: "_id orderId" });
    expect(select).toHaveBeenCalledWith("_id orderId");
  });
});

describe("listStuckCompletedOrders", () => {
  it("cutoff = Date.now() - staleAfterMs + 3-field filter", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    Order.find.mockReturnValueOnce({ lean });
    const before = Date.now();
    await listStuckCompletedOrders({ staleAfterMs: 60 * 60 * 1000 });
    const [filter] = Order.find.mock.calls[0];
    expect(filter.status).toBe("completed");
    expect(filter["domains.status"]).toBe("pending");
    expect(filter.createdAt.$lt.getTime()).toBeGreaterThanOrEqual(
      before - 60 * 60 * 1000
    );
  });

  it("optional select applies .select() chain", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const select = vi.fn().mockReturnValueOnce({ lean });
    Order.find.mockReturnValueOnce({ select });
    await listStuckCompletedOrders({ staleAfterMs: 1000, select: "orderId" });
    expect(select).toHaveBeenCalledWith("orderId");
  });
});

describe("findInvoiceNumberConflicts — aggregation pipeline", () => {
  it("pipeline: $match → $group → $match count>1 → $sort → $limit 100", async () => {
    Order.aggregate.mockResolvedValueOnce([]);
    await findInvoiceNumberConflicts();
    const [pipeline] = Order.aggregate.mock.calls[0];
    expect(pipeline).toEqual([
      { $match: { invoiceNumber: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: "$invoiceNumber",
          count: { $sum: 1 },
          orderIds: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 100 },
    ]);
  });
});

describe("listOrdersByIds", () => {
  it("empty ids → returns [] WITHOUT a Mongo round trip", async () => {
    expect(await listOrdersByIds([])).toEqual([]);
    expect(Order.find).not.toHaveBeenCalled();
  });

  it("non-empty ids: find({_id:{$in:ids}})", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    Order.find.mockReturnValueOnce({ lean });
    await listOrdersByIds(["a", "b"]);
    expect(Order.find).toHaveBeenCalledWith({ _id: { $in: ["a", "b"] } });
  });
});

describe("listStuckZohoInvoiceOrdersAdmin", () => {
  it("$or covers 5 unclaimed forms (not-exists / null / empty / creation_failed / pending_creation)", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    Order.find.mockReturnValueOnce({ sort });
    await listStuckZohoInvoiceOrdersAdmin();
    const [filter] = Order.find.mock.calls[0];
    expect(filter.status.$in).toEqual(["completed", "paid"]);
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(filter.$or).toEqual([
      { zohoInvoiceId: { $exists: false } },
      { zohoInvoiceId: null },
      { zohoInvoiceId: "" },
      { zohoInvoiceId: "creation_failed" },
      { zohoInvoiceId: "pending_creation" },
    ]);
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(limit).toHaveBeenCalledWith(100);
  });

  it("custom limit honoured", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    Order.find.mockReturnValueOnce({ sort });
    await listStuckZohoInvoiceOrdersAdmin({ limit: 25 });
    expect(limit).toHaveBeenCalledWith(25);
  });
});

describe("listOrdersWithInFlightDomains", () => {
  it("filter: not-deleted + domains.status in [pending, processing] + populate owner + 1000-row cap", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    const populate = vi.fn().mockReturnValue({ sort });
    Order.find.mockReturnValueOnce({ populate });
    await listOrdersWithInFlightDomains();
    expect(populate).toHaveBeenCalledWith(
      "userId",
      "firstName lastName email phone companyName"
    );
    expect(limit).toHaveBeenCalledWith(1000);
  });
});

describe("countAllOrders + listOrdersByRazorpayPaymentIds + clearOrderInvoiceNumber", () => {
  it("countAllOrders delegates to countDocuments", async () => {
    Order.countDocuments.mockResolvedValueOnce(42);
    expect(await countAllOrders()).toBe(42);
  });

  it("listOrdersByRazorpayPaymentIds: empty array → [] (no Mongo call)", async () => {
    expect(await listOrdersByRazorpayPaymentIds([])).toEqual([]);
    expect(Order.find).not.toHaveBeenCalled();
  });

  it("listOrdersByRazorpayPaymentIds with ids: populates user", async () => {
    const populate = vi.fn().mockResolvedValueOnce([]);
    Order.find.mockReturnValueOnce({ populate });
    await listOrdersByRazorpayPaymentIds(["pay_1", "pay_2"]);
    expect(Order.find).toHaveBeenCalledWith({
      razorpayPaymentId: { $in: ["pay_1", "pay_2"] },
    });
  });

  it("clearOrderInvoiceNumber: $unset invoiceNumber + returns modifiedCount", async () => {
    Order.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    const result = await clearOrderInvoiceNumber("O1");
    expect(Order.updateOne).toHaveBeenCalledWith(
      { _id: "O1" },
      { $unset: { invoiceNumber: "" } }
    );
    expect(result).toEqual({ modifiedCount: 1 });
  });
});

describe("getOrderByRazorpayPaymentId + findOrderByRazorpayOrderIdOrInternalId + getOrderByRazorpayOrderId", () => {
  it("getOrderByRazorpayPaymentId: findOne({razorpayPaymentId})", async () => {
    Order.findOne.mockResolvedValueOnce({ _id: "O1" });
    await getOrderByRazorpayPaymentId("pay_xyz");
    expect(Order.findOne).toHaveBeenCalledWith({ razorpayPaymentId: "pay_xyz" });
  });

  it("findOrderByRazorpayOrderIdOrInternalId: BOTH supplied → $or both", async () => {
    Order.findOne.mockResolvedValueOnce({ _id: "O1" });
    await findOrderByRazorpayOrderIdOrInternalId("ord_42", "rzp_99");
    expect(Order.findOne).toHaveBeenCalledWith({
      $or: [{ orderId: "ord_42" }, { razorpayOrderId: "rzp_99" }],
    });
  });

  it("findOrderByRazorpayOrderIdOrInternalId: ONLY internal supplied → $or has one entry", async () => {
    Order.findOne.mockResolvedValueOnce(null);
    await findOrderByRazorpayOrderIdOrInternalId("ord_42", undefined);
    expect(Order.findOne).toHaveBeenCalledWith({
      $or: [{ orderId: "ord_42" }],
    });
  });

  it("findOrderByRazorpayOrderIdOrInternalId: BOTH undefined → returns null WITHOUT Mongo call", async () => {
    expect(
      await findOrderByRazorpayOrderIdOrInternalId(undefined, undefined)
    ).toBeNull();
    expect(Order.findOne).not.toHaveBeenCalled();
  });

  it("getOrderByRazorpayOrderId: optional orderType narrows the filter", async () => {
    Order.findOne.mockResolvedValueOnce(null);
    await getOrderByRazorpayOrderId("rzp_42", { orderType: "hosting_upgrade" });
    expect(Order.findOne).toHaveBeenCalledWith({
      razorpayOrderId: "rzp_42",
      orderType: "hosting_upgrade",
    });
  });
});

describe("findUserOrder — privacy-safe lookup", () => {
  it("24-hex input + ALWAYS includes userId + isDeleted filter", async () => {
    const lean = vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) });
    Order.findOne.mockReturnValueOnce({ lean });
    await findUserOrder("507f1f77bcf86cd799439011", "USER_ID");
    const [filter] = Order.findOne.mock.calls[0];
    expect(filter._id).toBe("507f1f77bcf86cd799439011");
    expect(filter.userId).toBe("USER_ID");
    expect(filter.isDeleted).toEqual({ $ne: true });
  });

  it("non-hex → filters by orderId + userId + not-deleted", async () => {
    const lean = vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) });
    Order.findOne.mockReturnValueOnce({ lean });
    await findUserOrder("ord_42", "USER_ID");
    const [filter] = Order.findOne.mock.calls[0];
    expect(filter.orderId).toBe("ord_42");
    expect(filter.userId).toBe("USER_ID");
  });

  it("optional select projection via .select() chain", async () => {
    const exec = vi.fn().mockResolvedValueOnce(null);
    const lean = vi.fn().mockReturnValueOnce({ exec });
    const select = vi.fn().mockReturnValueOnce({ lean });
    Order.findOne.mockReturnValueOnce({ select });
    await findUserOrder("ord_42", "USER_ID", { select: "orderId status" });
    expect(select).toHaveBeenCalledWith("orderId status");
  });
});

describe("listOrdersForAdmin — pagination + hard-deleted-user fallback", () => {
  it("default page=1, perPage=100, skip=0; excludes pending (default)", async () => {
    const populate = vi
      .fn()
      .mockResolvedValueOnce([
        { toObject: () => ({ _id: "O1", userId: { firstName: "A", lastName: "B", email: "x" } }) },
      ]);
    const limit = vi.fn().mockReturnValue({ populate });
    const skip = vi.fn().mockReturnValue({ limit });
    const sort = vi.fn().mockReturnValue({ skip });
    Order.find.mockReturnValueOnce({ sort });
    Order.countDocuments.mockResolvedValueOnce(1);
    const result = await listOrdersForAdmin({});
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(100);
    expect(skip).toHaveBeenCalledWith(0);
    expect(limit).toHaveBeenCalledWith(100);
    const [filter] = Order.find.mock.calls[0];
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(filter.status).toEqual({ $ne: "pending" });
  });

  it("archived:true → flips to isDeleted:true filter", async () => {
    const populate = vi.fn().mockResolvedValueOnce([]);
    const limit = vi.fn().mockReturnValue({ populate });
    const skip = vi.fn().mockReturnValue({ limit });
    const sort = vi.fn().mockReturnValue({ skip });
    Order.find.mockReturnValueOnce({ sort });
    Order.countDocuments.mockResolvedValueOnce(0);
    await listOrdersForAdmin({ archived: true });
    const [filter] = Order.find.mock.calls[0];
    expect(filter.isDeleted).toBe(true);
  });

  it("includePending:true → no status filter", async () => {
    const populate = vi.fn().mockResolvedValueOnce([]);
    const limit = vi.fn().mockReturnValue({ populate });
    const skip = vi.fn().mockReturnValue({ limit });
    const sort = vi.fn().mockReturnValue({ skip });
    Order.find.mockReturnValueOnce({ sort });
    Order.countDocuments.mockResolvedValueOnce(0);
    await listOrdersForAdmin({ includePending: true });
    const [filter] = Order.find.mock.calls[0];
    expect(filter.status).toBeUndefined();
  });

  it("HARD-DELETED-USER fallback: synthesises userId stub from userName/userEmail snapshot", async () => {
    const orderWithDeletedUser = {
      toObject: () => ({
        _id: "O1",
        userId: null,
        userName: "Alice Smith",
        userEmail: "alice@x.test",
      }),
    };
    const populate = vi.fn().mockResolvedValueOnce([orderWithDeletedUser]);
    const limit = vi.fn().mockReturnValue({ populate });
    const skip = vi.fn().mockReturnValue({ limit });
    const sort = vi.fn().mockReturnValue({ skip });
    Order.find.mockReturnValueOnce({ sort });
    Order.countDocuments.mockResolvedValueOnce(1);
    const result = await listOrdersForAdmin({});
    expect(result.orders[0].userId).toEqual({
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@x.test",
      _id: null,
      isDeleted: true,
    });
  });

  it("pagination: hasMore = skip + orders.length < total", async () => {
    const populate = vi
      .fn()
      .mockResolvedValueOnce([
        { toObject: () => ({ _id: "O1", userId: { firstName: "A", lastName: "B", email: "x" } }) },
      ]);
    const limit = vi.fn().mockReturnValue({ populate });
    const skip = vi.fn().mockReturnValue({ limit });
    const sort = vi.fn().mockReturnValue({ skip });
    Order.find.mockReturnValueOnce({ sort });
    Order.countDocuments.mockResolvedValueOnce(100); // 100 total, 1 fetched at page 1
    const result = await listOrdersForAdmin({ page: 1, perPage: 1 });
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(100);
  });

  it("page/perPage floored to >= 1 (no zero or negative)", async () => {
    const populate = vi.fn().mockResolvedValueOnce([]);
    const limit = vi.fn().mockReturnValue({ populate });
    const skip = vi.fn().mockReturnValue({ limit });
    const sort = vi.fn().mockReturnValue({ skip });
    Order.find.mockReturnValueOnce({ sort });
    Order.countDocuments.mockResolvedValueOnce(0);
    const result = await listOrdersForAdmin({ page: 0, perPage: 0 });
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(1);
  });
});

describe("pure helpers", () => {
  const order = {
    domains: [
      { domainName: "x.com", status: "registered" },
      { domainName: "y.com", status: "pending" },
      { domainName: "z.com", status: "failed" },
    ],
  } as never;

  it("findOrderDomain returns the matching entry by exact-name", () => {
    expect(findOrderDomain(order, "y.com")?.status).toBe("pending");
    expect(findOrderDomain(order, "missing.com")).toBeUndefined();
  });

  it("mapOrderDomains projects each domain via the mapper", () => {
    const names = mapOrderDomains(order, (d) => d.domainName);
    expect(names).toEqual(["x.com", "y.com", "z.com"]);
  });

  it("filterOrderDomainsByName: Set-membership lookup", () => {
    const result = filterOrderDomainsByName(order, ["x.com", "z.com"]);
    expect(result.map((d) => d.domainName)).toEqual(["x.com", "z.com"]);
  });

  it("filterOrderDomainsByName: empty wanted set → empty result", () => {
    expect(filterOrderDomainsByName(order, [])).toEqual([]);
  });
});

describe("domain-keyed lookups", () => {
  it("findOrderByDomainForUser includes userId + isDeleted (privacy-safe)", async () => {
    Order.findOne.mockResolvedValueOnce(null);
    await findOrderByDomainForUser("USER_ID", "x.com");
    expect(Order.findOne).toHaveBeenCalledWith({
      "domains.domainName": "x.com",
      userId: "USER_ID",
      isDeleted: { $ne: true },
    });
  });

  it("findOrderByDomain (admin) has NO userId scope but still filters isDeleted", async () => {
    Order.findOne.mockResolvedValueOnce(null);
    await findOrderByDomain("x.com");
    const [filter] = Order.findOne.mock.calls[0];
    expect(filter.userId).toBeUndefined();
    expect(filter.isDeleted).toEqual({ $ne: true });
  });

  it("findOrderByDomain optional populate passes through", async () => {
    const populate = vi.fn().mockResolvedValueOnce(null);
    Order.findOne.mockReturnValueOnce({ populate });
    await findOrderByDomain("x.com", {
      populate: { path: "userId", select: "email" },
    });
    expect(populate).toHaveBeenCalledWith("userId", "email");
  });

  it("findOrdersByDomainName: NO isDeleted filter (refund/audit views need soft-deleted rows)", async () => {
    Order.find.mockResolvedValueOnce([]);
    await findOrdersByDomainName("x.com");
    const [filter] = Order.find.mock.calls[0];
    expect(filter.isDeleted).toBeUndefined();
    expect(filter["domains.domainName"]).toBe("x.com");
  });
});
