/**
 * Tests for `@/lib/invoice-retry` — re-runs our own GST engine for orders
 * whose invoice attempt FAILED. Replaces lib/zoho-invoice-retry (removed with
 * Zoho Books on 24 Sep 2026). Pins:
 *  - **5-minute Redis throttle** keyed `invoice-retry:<order _id>` on the
 *    self-heal path; a throttle hit short-circuits BEFORE any order read or
 *    engine call.
 *  - **Double-billing guard**: the order is re-read fresh and, if it has ANY
 *    `invoiceProvider` ('primary' or historical 'zoho'), the engine is never
 *    called — even though the list said it had failed.
 *  - Engine is called through the one chokepoint with the full order and a
 *    5-minute stale-claim window.
 *  - Engine `skipped` → `already_done` (a concurrent request won the claim).
 *  - **Failure refreshes `invoiceFailedAt`** with the engine's message, and
 *    selfHeal does NOT throw — the sweep continues to the next order. A
 *    failing flag write is logged loudly, not swallowed silently.
 *  - **syncUserInvoicesNow bypasses the throttle** and may throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FailedInvoiceOrder } from "@/lib/services/orders";

const redisCache = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/redis", () => ({ redisCache }));

const serverLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/server-logger", () => ({ serverLogger }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const getOrderById = vi.hoisted(() => vi.fn());
const listFailedInvoiceOrders = vi.hoisted(() => vi.fn());
const markInvoiceCreationFailed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  getOrderById,
  listFailedInvoiceOrders,
  markInvoiceCreationFailed,
}));

const createPrimaryInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/billing/createPrimaryInvoice", () => ({ createPrimaryInvoice }));

const cartItemsFromOrderDomains = vi.hoisted(() =>
  vi.fn((domains: unknown[]) => domains.map((d) => ({ ...(d as object), mapped: true })))
);
vi.mock("@/lib/services/payment/order-creator", () => ({ cartItemsFromOrderDomains }));

import { selfHealUserInvoices, syncUserInvoicesNow } from "@/lib/invoice-retry";

const OID = { toString: () => "ORDER_OID_1" };

function row(overrides: Record<string, unknown> = {}): FailedInvoiceOrder {
  return {
    _id: OID,
    orderId: "ORD-1",
    userId: "U1",
    amount: 1180,
    domains: [{ domainName: "x.com", price: 1000 }],
    ...overrides,
  } as unknown as FailedInvoiceOrder;
}

function freshOrder(overrides: Record<string, unknown> = {}) {
  return {
    _id: OID,
    orderId: "ORD-1",
    amount: 1180,
    currency: "INR",
    razorpayPaymentId: "pay_rzp",
    paymentId: "pay_legacy",
    domains: [{ domainName: "x.com", price: 1000 }],
    ...overrides,
  };
}

const USER = { _id: "U1", email: "u@x.test" };

beforeEach(() => {
  for (const fn of [
    redisCache.get,
    redisCache.set,
    serverLogger.info,
    serverLogger.warn,
    serverLogger.error,
    getUserById,
    getOrderById,
    listFailedInvoiceOrders,
    markInvoiceCreationFailed,
    createPrimaryInvoice,
  ]) {
    fn.mockReset();
  }
  cartItemsFromOrderDomains.mockClear();
  redisCache.get.mockResolvedValue(null);
  redisCache.set.mockResolvedValue(undefined);
  getOrderById.mockResolvedValue(freshOrder());
  getUserById.mockResolvedValue(USER);
  markInvoiceCreationFailed.mockResolvedValue(undefined);
  createPrimaryInvoice.mockResolvedValue({
    invoiceId: "TI/2026-27/00009",
    invoiceNumber: "TI/2026-27/00009",
    provider: "primary",
  });
});

describe("selfHealUserInvoices — empty list", () => {
  it("no failed orders → [] and nothing else is touched", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([]);
    expect(await selfHealUserInvoices("U1")).toEqual([]);
    expect(listFailedInvoiceOrders).toHaveBeenCalledWith("U1");
    expect(redisCache.get).not.toHaveBeenCalled();
    expect(getOrderById).not.toHaveBeenCalled();
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });
});

describe("selfHealUserInvoices — throttle", () => {
  it("recent attempt in Redis → skipped:'throttled', no order read, no engine call", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
    redisCache.get.mockResolvedValueOnce(1_700_000_000_000);

    const r = await selfHealUserInvoices("U1");

    expect(r).toEqual([{ ok: false, orderId: "ORD-1", skipped: "throttled" }]);
    expect(redisCache.get).toHaveBeenCalledWith("invoice-retry:ORDER_OID_1");
    expect(redisCache.set).not.toHaveBeenCalled();
    expect(getOrderById).not.toHaveBeenCalled();
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("no recent attempt → sets the throttle key for 5 minutes before trying", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
    await selfHealUserInvoices("U1");
    expect(redisCache.set).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = redisCache.set.mock.calls[0];
    expect(key).toBe("invoice-retry:ORDER_OID_1");
    expect(typeof value).toBe("number");
    expect(ttl).toBe(300);
    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
  });
});

describe("selfHealUserInvoices — double-billing guard", () => {
  it.each(["primary", "zoho"])(
    "fresh order already has invoiceProvider '%s' → already_done, engine NEVER called",
    async (provider) => {
      listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
      getOrderById.mockResolvedValueOnce(freshOrder({ invoiceProvider: provider }));

      const r = await selfHealUserInvoices("U1");

      expect(r).toEqual([{ ok: false, orderId: "ORD-1", skipped: "already_done" }]);
      expect(getOrderById).toHaveBeenCalledWith("ORDER_OID_1");
      expect(createPrimaryInvoice).not.toHaveBeenCalled();
      expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
    }
  );

  it("order vanished since the list ran → no_order, engine not called", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
    getOrderById.mockResolvedValueOnce(null);
    const r = await selfHealUserInvoices("U1");
    expect(r).toEqual([{ ok: false, orderId: "ORD-1", skipped: "no_order" }]);
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("user not found → no_user, engine not called", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
    getUserById.mockResolvedValueOnce(null);
    const r = await selfHealUserInvoices("U1");
    expect(r).toEqual([
      { ok: false, orderId: "ORD-1", skipped: "no_user", error: "User not found" },
    ]);
    expect(getUserById).toHaveBeenCalledWith("U1");
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("engine reports skipped (concurrent claim won) → already_done, not ok", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
    createPrimaryInvoice.mockResolvedValueOnce({ invoiceId: "", invoiceNumber: null, provider: "skipped" });
    const r = await selfHealUserInvoices("U1");
    expect(r).toEqual([{ ok: false, orderId: "ORD-1", skipped: "already_done" }]);
  });
});

describe("selfHealUserInvoices — success", () => {
  it("calls the chokepoint with the FRESH order, payment id, and a 5-minute stale-claim window", async () => {
    const order = freshOrder();
    getOrderById.mockResolvedValueOnce(order);
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);

    const r = await selfHealUserInvoices("U1");

    expect(r).toEqual([{ ok: true, orderId: "ORD-1", invoiceNumber: "TI/2026-27/00009" }]);
    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
    const [ctx, options] = createPrimaryInvoice.mock.calls[0];
    expect(ctx.order).toBe(order);
    expect(ctx.orderId).toBe("ORD-1");
    expect(ctx.user).toBe(USER);
    expect(ctx.razorpay_payment_id).toBe("pay_rzp");
    expect(ctx.paymentDetails).toEqual({ id: "pay_rzp", amount: 1180, currency: "INR" });
    expect(ctx.cartItems).toEqual([{ domainName: "x.com", price: 1000, mapped: true }]);
    expect(options).toEqual({ claimOptions: { staleClaimAfterMs: 5 * 60 * 1000 } });
    expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
  });

  it("falls back to paymentId when razorpayPaymentId is absent", async () => {
    getOrderById.mockResolvedValueOnce(freshOrder({ razorpayPaymentId: undefined }));
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
    await selfHealUserInvoices("U1");
    expect(createPrimaryInvoice.mock.calls[0][0].razorpay_payment_id).toBe("pay_legacy");
  });
});

describe("selfHealUserInvoices — failure", () => {
  it("engine throws → invoiceFailedAt refreshed with the message, result carries the error, no throw", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
    createPrimaryInvoice.mockRejectedValueOnce(new Error("COMPANY_STATE is not configured"));

    const r = await selfHealUserInvoices("U1");

    expect(r).toEqual([
      { ok: false, orderId: "ORD-1", error: "COMPANY_STATE is not configured" },
    ]);
    expect(markInvoiceCreationFailed).toHaveBeenCalledTimes(1);
    expect(markInvoiceCreationFailed).toHaveBeenCalledWith(OID, "COMPANY_STATE is not configured");
  });

  it("one failure does not stop the sweep — the next order is still tried", async () => {
    const OID2 = { toString: () => "ORDER_OID_2" };
    listFailedInvoiceOrders.mockResolvedValueOnce([
      row(),
      row({ _id: OID2, orderId: "ORD-2" }),
    ]);
    getOrderById
      .mockResolvedValueOnce(freshOrder())
      .mockResolvedValueOnce(freshOrder({ _id: OID2, orderId: "ORD-2" }));
    createPrimaryInvoice
      .mockRejectedValueOnce(new Error("counter unreachable"))
      .mockResolvedValueOnce({ invoiceId: "TI/2", invoiceNumber: "TI/2", provider: "primary" });

    const r = await selfHealUserInvoices("U1");

    expect(r).toEqual([
      { ok: false, orderId: "ORD-1", error: "counter unreachable" },
      { ok: true, orderId: "ORD-2", invoiceNumber: "TI/2" },
    ]);
    expect(markInvoiceCreationFailed).toHaveBeenCalledTimes(1);
  });

  it("a failing flag refresh is logged loudly and still does not throw", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
    createPrimaryInvoice.mockRejectedValueOnce(new Error("engine down"));
    markInvoiceCreationFailed.mockRejectedValueOnce(new Error("mongo down"));

    const r = await selfHealUserInvoices("U1");

    expect(r).toEqual([{ ok: false, orderId: "ORD-1", error: "engine down" }]);
    const logged = serverLogger.error.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toContain("ALSO failed to refresh invoiceFailedAt");
    expect(logged).toContain("mongo down");
  });

  it("listing itself fails → [] (a page load must not fail because a retry did)", async () => {
    listFailedInvoiceOrders.mockRejectedValueOnce(new Error("mongo down"));
    expect(await selfHealUserInvoices("U1")).toEqual([]);
    expect(serverLogger.error).toHaveBeenCalled();
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });
});

describe("syncUserInvoicesNow", () => {
  it("bypasses the throttle entirely — Redis is neither read nor written", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
    redisCache.get.mockResolvedValue(1_700_000_000_000); // would throttle selfHeal

    const r = await syncUserInvoicesNow("U1");

    expect(r).toEqual([{ ok: true, orderId: "ORD-1", invoiceNumber: "TI/2026-27/00009" }]);
    expect(redisCache.get).not.toHaveBeenCalled();
    expect(redisCache.set).not.toHaveBeenCalled();
    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
  });

  it("still honours the double-billing guard", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([row()]);
    getOrderById.mockResolvedValueOnce(freshOrder({ invoiceProvider: "primary" }));
    const r = await syncUserInvoicesNow("U1");
    expect(r).toEqual([{ ok: false, orderId: "ORD-1", skipped: "already_done" }]);
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("no failed orders → []", async () => {
    listFailedInvoiceOrders.mockResolvedValueOnce([]);
    expect(await syncUserInvoicesNow("U1")).toEqual([]);
  });

  it("listing failure propagates — the user pressed a button and should see it fail", async () => {
    listFailedInvoiceOrders.mockRejectedValueOnce(new Error("mongo down"));
    await expect(syncUserInvoicesNow("U1")).rejects.toThrow("mongo down");
  });
});
