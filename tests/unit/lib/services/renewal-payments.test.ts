/**
 * Tests for `@/lib/services/renewal-payments` (rescan-4 slice 7dv).
 * Idempotency-guard for the Razorpay subscription.charged webhook.
 * Pins the lock protocol:
 *  - recordRenewalPayment: inserts with processed=false + status='success'
 *  - getRenewalByProviderPaymentId: findOne({providerPaymentId})
 *  - claimRenewalPayment: atomic findOneAndUpdate(processed:false → true)
 *    with processedAt stamped, new:true (returns updated doc)
 *  - releaseRenewalClaim: $set processed:false + $unset processedAt
 *  - attachOrderToRenewal: $set orderId only (no transition lock involved)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const createMock = vi.hoisted(() => vi.fn());
const findOneMock = vi.hoisted(() => vi.fn());
const findOneAndUpdateMock = vi.hoisted(() => vi.fn());
const updateOneMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/RenewalPayment", () => ({
  default: {
    create: createMock,
    findOne: findOneMock,
    findOneAndUpdate: findOneAndUpdateMock,
    updateOne: updateOneMock,
  },
}));

import {
  recordRenewalPayment,
  getRenewalByProviderPaymentId,
  claimRenewalPayment,
  releaseRenewalClaim,
  attachOrderToRenewal,
} from "@/lib/services/renewal-payments";

const BASE = {
  serviceId: "svc_1",
  serviceType: "hosting" as const,
  providerPaymentId: "pay_xyz",
  amount: 999,
  currency: "INR",
  renewalDurationMonths: 12,
};

beforeEach(() => {
  connectDBMock.mockReset();
  createMock.mockReset();
  findOneMock.mockReset();
  findOneAndUpdateMock.mockReset();
  updateOneMock.mockReset();
});

describe("recordRenewalPayment", () => {
  it("inserts with processed=false + status='success' + the documented payload shape", async () => {
    createMock.mockResolvedValueOnce({ _id: "r1" });
    const result = await recordRenewalPayment(BASE);
    expect(connectDBMock).toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith({
      serviceId: "svc_1",
      serviceType: "hosting",
      providerPaymentId: "pay_xyz",
      subscriptionId: undefined,
      amount: 999,
      currency: "INR",
      status: "success",
      processed: false,
      renewalDurationMonths: 12,
    });
    expect(result).toMatchObject({ _id: "r1" });
  });

  it("forwards optional subscriptionId when supplied", async () => {
    createMock.mockResolvedValueOnce({ _id: "r2" });
    await recordRenewalPayment({ ...BASE, subscriptionId: "sub_abc" });
    expect(createMock.mock.calls[0][0].subscriptionId).toBe("sub_abc");
  });

  it("propagates Mongo duplicate-key 11000 errors (callers catch as 'already seen')", async () => {
    const e = new Error("E11000 duplicate key") as Error & { code: number };
    e.code = 11000;
    createMock.mockRejectedValueOnce(e);
    await expect(recordRenewalPayment(BASE)).rejects.toMatchObject({ code: 11000 });
  });
});

describe("getRenewalByProviderPaymentId", () => {
  it("looks up by providerPaymentId", async () => {
    findOneMock.mockResolvedValueOnce({ _id: "r", processed: false });
    const doc = await getRenewalByProviderPaymentId("pay_xyz");
    expect(findOneMock).toHaveBeenCalledWith({ providerPaymentId: "pay_xyz" });
    expect(doc).toMatchObject({ _id: "r", processed: false });
  });

  it("returns null when no row exists", async () => {
    findOneMock.mockResolvedValueOnce(null);
    expect(await getRenewalByProviderPaymentId("missing")).toBeNull();
  });
});

describe("claimRenewalPayment", () => {
  it("atomic flip: filter requires processed:false, $set flips to true + stamps processedAt, new:true returns updated", async () => {
    findOneAndUpdateMock.mockResolvedValueOnce({ _id: "r", processed: true });
    const result = await claimRenewalPayment("pay_xyz");
    expect(findOneAndUpdateMock).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = findOneAndUpdateMock.mock.calls[0];
    expect(filter).toEqual({ providerPaymentId: "pay_xyz", processed: false });
    expect(update.$set.processed).toBe(true);
    expect(update.$set.processedAt).toBeInstanceOf(Date);
    expect(opts).toEqual({ new: true });
    expect(result).toMatchObject({ _id: "r", processed: true });
  });

  it("returns null when another worker had already claimed (filter no-match)", async () => {
    findOneAndUpdateMock.mockResolvedValueOnce(null);
    expect(await claimRenewalPayment("pay_xyz")).toBeNull();
  });
});

describe("releaseRenewalClaim", () => {
  it("unwinds the claim: $set processed:false + $unset processedAt", async () => {
    updateOneMock.mockResolvedValueOnce({ acknowledged: true });
    await releaseRenewalClaim("pay_xyz");
    expect(updateOneMock).toHaveBeenCalledWith(
      { providerPaymentId: "pay_xyz" },
      { $set: { processed: false }, $unset: { processedAt: "" } }
    );
  });
});

describe("attachOrderToRenewal", () => {
  it("cross-links by $set orderId only (no claim transition)", async () => {
    updateOneMock.mockResolvedValueOnce({ acknowledged: true });
    await attachOrderToRenewal("pay_xyz", "ord_42");
    expect(updateOneMock).toHaveBeenCalledWith(
      { providerPaymentId: "pay_xyz" },
      { $set: { orderId: "ord_42" } }
    );
  });
});
