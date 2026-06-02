/**
 * Tests for `@/lib/services/orders` — Zoho-invoice claim protocol +
 * pending-order claim (rescan-4 slice 7ek). Pins:
 *  - **claimOrderForZohoInvoice** uses findOneAndUpdate with an $or
 *    of "unclaimed" forms: zohoInvoiceId not-exists OR ""; opts.allowNull
 *    adds {zohoInvoiceId: null}; opts.allowFailed adds the
 *    "creation_failed" sentinel (retry cron); opts.staleClaimAfterMs
 *    adds the "pending_creation + updatedAt before cutoff" form (steal
 *    stalled claims)
 *  - claim sets zohoInvoiceId:"pending_creation" + new:true (returns
 *    the post-claim doc — caller checks for null=lost-race)
 *  - recordZohoInvoiceForOrder writes both invoiceId + optional
 *    invoiceNumber; **E11000 duplicate-key collision on invoiceNumber
 *    falls back to writing JUST the invoiceId** (Zoho's own idempotency
 *    layer may attribute the same number to two local Orders — View/
 *    Download still works without the local number; this preserves
 *    the local unique index)
 *  - recordZohoInvoice non-11000 errors rethrow
 *  - releaseZohoInvoiceClaim: guarded by zohoInvoiceId:"pending_creation"
 *    (concurrent worker can't accidentally clear someone else's claim);
 *    $unset removes the field entirely
 *  - markZohoInvoiceCreationFailed: also guarded by "pending_creation";
 *    transitions to terminal "creation_failed" sentinel
 *  - **claimPendingOrderForProcessing** atomically transitions
 *    pending → processing guarded by status:"pending" (so /verify and
 *    /razorpay/webhook converge on the same row exactly once)
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

import {
  claimOrderForZohoInvoice,
  recordZohoInvoiceForOrder,
  releaseZohoInvoiceClaim,
  markZohoInvoiceCreationFailed,
  claimPendingOrderForProcessing,
} from "@/lib/services/orders";

beforeEach(() => {
  connectDB.mockReset();
  Object.values(Order).forEach((fn) =>
    (fn as ReturnType<typeof vi.fn>).mockReset()
  );
});

describe("claimOrderForZohoInvoice — atomic claim protocol", () => {
  it("base: $or of [not-exists, empty-string] + sets pending_creation + new:true", async () => {
    Order.findOneAndUpdate.mockResolvedValueOnce({ _id: "O1" });
    await claimOrderForZohoInvoice("O1");
    const [filter, update, opts] = Order.findOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe("O1");
    expect(filter.$or).toEqual([
      { zohoInvoiceId: { $exists: false } },
      { zohoInvoiceId: "" },
    ]);
    expect(update).toEqual({ $set: { zohoInvoiceId: "pending_creation" } });
    expect(opts).toEqual({ new: true });
  });

  it("allowNull:true adds {zohoInvoiceId: null}", async () => {
    Order.findOneAndUpdate.mockResolvedValueOnce(null);
    await claimOrderForZohoInvoice("O1", { allowNull: true });
    const [filter] = Order.findOneAndUpdate.mock.calls[0];
    expect(filter.$or).toContainEqual({ zohoInvoiceId: null });
  });

  it("allowFailed:true adds the 'creation_failed' sentinel (retry cron)", async () => {
    Order.findOneAndUpdate.mockResolvedValueOnce(null);
    await claimOrderForZohoInvoice("O1", { allowFailed: true });
    const [filter] = Order.findOneAndUpdate.mock.calls[0];
    expect(filter.$or).toContainEqual({ zohoInvoiceId: "creation_failed" });
  });

  it("staleClaimAfterMs adds the 'steal stalled claim' form (pending_creation + old updatedAt)", async () => {
    Order.findOneAndUpdate.mockResolvedValueOnce(null);
    await claimOrderForZohoInvoice("O1", { staleClaimAfterMs: 5 * 60 * 1000 });
    const [filter] = Order.findOneAndUpdate.mock.calls[0];
    const stealForm = filter.$or.find(
      (c: { zohoInvoiceId?: string }) =>
        c.zohoInvoiceId === "pending_creation"
    );
    expect(stealForm).toBeDefined();
    expect(stealForm.updatedAt.$lt).toBeInstanceOf(Date);
  });

  it("staleClaimAfterMs:0 does NOT add the steal form (only positive values)", async () => {
    Order.findOneAndUpdate.mockResolvedValueOnce(null);
    await claimOrderForZohoInvoice("O1", { staleClaimAfterMs: 0 });
    const [filter] = Order.findOneAndUpdate.mock.calls[0];
    const stealForm = filter.$or.find(
      (c: { zohoInvoiceId?: string }) =>
        c.zohoInvoiceId === "pending_creation"
    );
    expect(stealForm).toBeUndefined();
  });

  it("lost race → returns null (caller treats as 'another worker has it')", async () => {
    Order.findOneAndUpdate.mockResolvedValueOnce(null);
    expect(await claimOrderForZohoInvoice("O1")).toBeNull();
  });
});

describe("recordZohoInvoiceForOrder — happy path + E11000 fallback", () => {
  it("writes zohoInvoiceId + invoiceNumber when both supplied", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    await recordZohoInvoiceForOrder("O1", {
      invoiceId: "INV_1",
      invoiceNumber: "INV-001",
    });
    const [filter, update] = Order.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "O1" });
    expect(update.$set).toEqual({
      zohoInvoiceId: "INV_1",
      invoiceNumber: "INV-001",
    });
  });

  it("invoiceNumber omitted → $set has zohoInvoiceId only", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    await recordZohoInvoiceForOrder("O1", { invoiceId: "INV_1" });
    const [, update] = Order.updateOne.mock.calls[0];
    expect(update.$set).toEqual({ zohoInvoiceId: "INV_1" });
  });

  it("E11000 duplicate-key collision on invoiceNumber → retry WITHOUT invoiceNumber (View/Download still works)", async () => {
    Order.updateOne
      .mockRejectedValueOnce(Object.assign(new Error("dup"), { code: 11000 }))
      .mockResolvedValueOnce({});
    await recordZohoInvoiceForOrder("O1", {
      invoiceId: "INV_1",
      invoiceNumber: "INV-DUPED",
    });
    expect(Order.updateOne).toHaveBeenCalledTimes(2);
    const [, retryUpdate] = Order.updateOne.mock.calls[1];
    expect(retryUpdate.$set).toEqual({ zohoInvoiceId: "INV_1" });
  });

  it("non-11000 error rethrows", async () => {
    Order.updateOne.mockRejectedValueOnce(new Error("network down"));
    await expect(
      recordZohoInvoiceForOrder("O1", { invoiceId: "INV_1" })
    ).rejects.toThrow("network down");
  });
});

describe("releaseZohoInvoiceClaim", () => {
  it("guarded by zohoInvoiceId:'pending_creation' + $unset zohoInvoiceId", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    await releaseZohoInvoiceClaim("O1");
    const [filter, update] = Order.updateOne.mock.calls[0];
    expect(filter).toEqual({
      _id: "O1",
      zohoInvoiceId: "pending_creation",
    });
    expect(update).toEqual({ $unset: { zohoInvoiceId: "" } });
  });
});

describe("markZohoInvoiceCreationFailed", () => {
  it("guarded by zohoInvoiceId:'pending_creation' + $set zohoInvoiceId:'creation_failed'", async () => {
    Order.updateOne.mockResolvedValueOnce({});
    await markZohoInvoiceCreationFailed("O1");
    const [filter, update] = Order.updateOne.mock.calls[0];
    expect(filter).toEqual({
      _id: "O1",
      zohoInvoiceId: "pending_creation",
    });
    expect(update).toEqual({ $set: { zohoInvoiceId: "creation_failed" } });
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
