/**
 * Tests for `@/lib/services/orders` — the invoice claim/failure protocol and
 * the pending-order claim. Replaces orders-zoho-claim.test.ts: Zoho Books was
 * removed on 24 Sep 2026, and with it the `zohoInvoiceId` sentinel field
 * ("pending_creation" / "creation_failed"). What replaced it, and is pinned
 * here:
 *
 *  - **markInvoiceCreationFailed** stamps `invoiceFailedAt` (+ an optional
 *    reason, capped at 500 chars) and is guarded by
 *    `invoiceProvider: {$exists:false}` — a failure flag can never land on an
 *    order that already has an invoice.
 *  - **listFailedInvoiceOrders** (user-scoped, retry input) lists only paid
 *    orders with NO invoiceProvider AND a known failure — an order that has
 *    an invoice (either engine, including historical 'zoho') is never
 *    retried, so no retry can double-bill.
 *  - **listUninvoicedPaidOrdersAdmin** (admin diagnostic) is broader — no
 *    failure flag needed — but still excludes invoiced, ₹0 and trial orders.
 *  - **recordPrimaryInvoiceForOrder** $unsets the failure fields when an
 *    invoice finally lands.
 *  - **claimOrderForPrimaryInvoice** keeps `invoiceProvider:{$exists:false}`
 *    in its filter — the double-billing guard now keys on the one field.
 *  - **claimPendingOrderForProcessing** atomically transitions
 *    pending → processing guarded by status:"pending" (so /verify and
 *    /razorpay/webhook converge on the same row exactly once).
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
  updateMany: vi.fn(),
  countDocuments: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
  aggregate: vi.fn(),
}));
vi.mock("@/models/Order", () => ({ default: Order }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import * as orders from "@/lib/services/orders";
import {
  markInvoiceCreationFailed,
  listFailedInvoiceOrders,
  listUninvoicedPaidOrdersAdmin,
  recordPrimaryInvoiceForOrder,
  claimOrderForPrimaryInvoice,
  releasePrimaryInvoiceClaim,
  claimPendingOrderForProcessing,
} from "@/lib/services/orders";

beforeEach(() => {
  connectDB.mockReset();
  Object.values(Order).forEach((fn) =>
    (fn as ReturnType<typeof vi.fn>).mockReset()
  );
});

describe("markInvoiceCreationFailed", () => {
  it("stamps invoiceFailedAt + reason, guarded so it never touches an invoiced order", async () => {
    Order.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    const before = Date.now();
    await markInvoiceCreationFailed("O1", "COMPANY_STATE is not configured");
    expect(connectDB).toHaveBeenCalled();
    const [filter, update] = Order.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "O1", invoiceProvider: { $exists: false } });
    expect(update.$set.invoiceFailureReason).toBe("COMPANY_STATE is not configured");
    expect(update.$set.invoiceFailedAt).toBeInstanceOf(Date);
    expect((update.$set.invoiceFailedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    // It flags — it does not claim, release, or mint anything.
    expect(Object.keys(update)).toEqual(["$set"]);
    expect(Object.keys(update.$set).sort()).toEqual(["invoiceFailedAt", "invoiceFailureReason"]);
  });

  it("no reason → only invoiceFailedAt is written (an old reason is not overwritten with undefined)", async () => {
    Order.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    await markInvoiceCreationFailed("O1");
    const [, update] = Order.updateOne.mock.calls[0];
    expect(Object.keys(update.$set)).toEqual(["invoiceFailedAt"]);
  });

  it("empty-string reason is treated as no reason", async () => {
    Order.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    await markInvoiceCreationFailed("O1", "");
    const [, update] = Order.updateOne.mock.calls[0];
    expect(Object.keys(update.$set)).toEqual(["invoiceFailedAt"]);
  });

  it("reason is capped at 500 chars so a huge stack cannot bloat the order document", async () => {
    Order.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    await markInvoiceCreationFailed("O1", "x".repeat(2000));
    const [, update] = Order.updateOne.mock.calls[0];
    expect(update.$set.invoiceFailureReason).toHaveLength(500);
  });

  it("a write error propagates — callers decide whether to swallow it", async () => {
    Order.updateOne.mockRejectedValueOnce(new Error("mongo down"));
    await expect(markInvoiceCreationFailed("O1", "r")).rejects.toThrow("mongo down");
  });
});

describe("listFailedInvoiceOrders (user-scoped retry input)", () => {
  it("paid/completed, not deleted, NO invoiceProvider, a KNOWN failure, slim projection, lean", async () => {
    const rows = [{ _id: "O1", orderId: "ORD-1" }];
    const lean = vi.fn().mockResolvedValueOnce(rows);
    const select = vi.fn().mockReturnValue({ lean });
    Order.find.mockReturnValueOnce({ select });

    const result = await listFailedInvoiceOrders("USER_ID");

    expect(result).toBe(rows);
    const [filter] = Order.find.mock.calls[0];
    expect(filter).toEqual({
      userId: "USER_ID",
      status: { $in: ["completed", "paid"] },
      isDeleted: { $ne: true },
      // The double-billing guard: any invoiceProvider — 'primary' or the
      // historical 'zoho' — means the order is invoiced and must never be
      // retried.
      invoiceProvider: { $exists: false },
      invoiceFailedAt: { $exists: true },
    });
    expect(select).toHaveBeenCalledWith(
      "_id orderId userId amount currency orderType createdAt razorpayPaymentId paymentId domains"
    );
  });
});

describe("listUninvoicedPaidOrdersAdmin (admin diagnostic)", () => {
  function chain(result: unknown[] = []) {
    const lean = vi.fn().mockResolvedValueOnce(result);
    const select = vi.fn().mockReturnValue({ lean });
    const limit = vi.fn().mockReturnValue({ lean, select });
    const sort = vi.fn().mockReturnValue({ limit });
    Order.find.mockReturnValueOnce({ sort });
    return { lean, select, limit, sort };
  }

  it("paid, not deleted, no invoice, amount > 0, not a trial; newest first; default limit 100", async () => {
    const { sort, limit } = chain();
    await listUninvoicedPaidOrdersAdmin();
    const [filter] = Order.find.mock.calls[0];
    expect(filter).toEqual({
      status: { $in: ["completed", "paid"] },
      isDeleted: { $ne: true },
      invoiceProvider: { $exists: false },
      amount: { $gt: 0 },
      orderType: { $ne: "hosting_trial" },
    });
    // Broader than the retry list on purpose: no invoiceFailedAt requirement.
    expect(filter).not.toHaveProperty("invoiceFailedAt");
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(limit).toHaveBeenCalledWith(100);
  });

  it("custom limit honoured", async () => {
    const { limit } = chain();
    await listUninvoicedPaidOrdersAdmin({ limit: 25 });
    expect(limit).toHaveBeenCalledWith(25);
  });

  it("select projection applied when given", async () => {
    const { select } = chain();
    await listUninvoicedPaidOrdersAdmin({ select: "orderId amount" });
    expect(select).toHaveBeenCalledWith("orderId amount");
  });
});

describe("recordPrimaryInvoiceForOrder", () => {
  const RECORD = {
    invoiceNumber: "TI/2026-27/00007",
    gstRate: 18,
    taxableValue: 1000,
    cgst: 90,
    sgst: 90,
    igst: 0,
    placeOfSupply: "Delhi",
  };

  it("stamps invoiceProvider 'primary' + GST breakdown AND clears the failure fields", async () => {
    Order.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    await recordPrimaryInvoiceForOrder("O1", RECORD);
    const [filter, update] = Order.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "O1" });
    expect(update.$set).toEqual({ invoiceProvider: "primary", ...RECORD });
    expect(update.$unset).toEqual({ invoiceFailedAt: "", invoiceFailureReason: "" });
  });

  it("customerGstin is written only when present", async () => {
    Order.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    await recordPrimaryInvoiceForOrder("O1", { ...RECORD, customerGstin: "27AAAAA0000A1Z5" });
    const [, update] = Order.updateOne.mock.calls[0];
    expect(update.$set.customerGstin).toBe("27AAAAA0000A1Z5");
  });
});

describe("claimOrderForPrimaryInvoice — the double-billing guard", () => {
  it("filter requires NO invoiceProvider, so an invoiced order (incl. historical 'zoho') cannot be claimed", async () => {
    Order.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    expect(await claimOrderForPrimaryInvoice("O1")).toBe(true);
    const [filter, update] = Order.updateOne.mock.calls[0];
    expect(filter._id).toBe("O1");
    expect(filter.invoiceProvider).toEqual({ $exists: false });
    expect(filter.$or).toEqual([{ primaryInvoiceClaimedAt: { $exists: false } }]);
    expect(update.$set.primaryInvoiceClaimedAt).toBeInstanceOf(Date);
  });

  it("staleClaimAfterMs adds the steal form but KEEPS the invoiceProvider guard", async () => {
    Order.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    expect(await claimOrderForPrimaryInvoice("O1", { staleClaimAfterMs: 5 * 60 * 1000 })).toBe(false);
    const [filter] = Order.updateOne.mock.calls[0];
    expect(filter.invoiceProvider).toEqual({ $exists: false });
    expect(filter.$or).toHaveLength(2);
    expect(filter.$or[1].primaryInvoiceClaimedAt.$lt).toBeInstanceOf(Date);
  });

  it("release never undoes a completed invoice (guarded by invoiceProvider)", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    await releasePrimaryInvoiceClaim("O1");
    const [filter, update] = Order.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "O1", invoiceProvider: { $exists: false } });
    expect(update).toEqual({ $unset: { primaryInvoiceClaimedAt: "" } });
  });
});

describe("the Zoho claim protocol is gone", () => {
  it("no zoho-named export survives on the orders service", () => {
    const zohoExports = Object.keys(orders).filter((k) => /zoho/i.test(k));
    expect(zohoExports).toEqual([]);
  });
});

describe("claimPendingOrderForProcessing", () => {
  it("findOneAndUpdate({razorpayOrderId, status:'pending'}, $set status:'processing', new:true)", async () => {
    Order.findOneAndUpdate.mockResolvedValueOnce({ _id: "O1" });
    await claimPendingOrderForProcessing("ord_rzp_42");
    const [filter, update, opts] = Order.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      razorpayOrderId: "ord_rzp_42",
      status: "pending",
    });
    expect(update.$set.status).toBe("processing");
    expect(opts).toEqual({ new: true });
  });

  it("razorpayPaymentId + signature + paymentVerification all stamped into $set when supplied", async () => {
    Order.findOneAndUpdate.mockResolvedValueOnce({ _id: "O1" });
    const verification = {
      verifiedAt: new Date(),
      paymentStatus: "captured",
      paymentAmount: 1000,
      paymentCurrency: "INR",
      razorpayOrderId: "ord_rzp",
    };
    await claimPendingOrderForProcessing("ord_rzp", {
      razorpayPaymentId: "pay_xyz",
      razorpaySignature: "sig_xyz",
      paymentVerification: verification,
    });
    const [, update] = Order.findOneAndUpdate.mock.calls[0];
    expect(update.$set.razorpayPaymentId).toBe("pay_xyz");
    expect(update.$set.razorpaySignature).toBe("sig_xyz");
    expect(update.$set.paymentVerification).toBe(verification);
  });

  it("no updates → only status:'processing' in $set", async () => {
    Order.findOneAndUpdate.mockResolvedValueOnce({ _id: "O1" });
    await claimPendingOrderForProcessing("ord_rzp");
    const [, update] = Order.findOneAndUpdate.mock.calls[0];
    expect(update.$set).toEqual({ status: "processing" });
  });

  it("lost race (order past 'pending') → returns null", async () => {
    Order.findOneAndUpdate.mockResolvedValueOnce(null);
    expect(await claimPendingOrderForProcessing("ord_rzp")).toBeNull();
  });
});
