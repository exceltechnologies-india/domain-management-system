/**
 * Service-layer integration tests for lib/services/renewal-payments.ts.
 *
 * Locks in the webhook-idempotency protocol: insert → claim → release →
 * attach-order. The lock is what keeps duplicate Razorpay deliveries from
 * double-renewing.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import RenewalPayment from "@/models/RenewalPayment";
import {
  attachOrderToRenewal,
  claimRenewalPayment,
  getRenewalByProviderPaymentId,
  recordRenewalPayment,
  releaseRenewalClaim,
} from "@/lib/services/renewal-payments";

const validServiceId = () => new mongoose.Types.ObjectId();

function buildPayload(overrides: Partial<Parameters<typeof recordRenewalPayment>[0]> = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  return {
    serviceId: validServiceId(),
    serviceType: "hosting" as const,
    providerPaymentId: `pay_${tag}`,
    subscriptionId: `sub_${tag}`,
    amount: 1000,
    currency: "INR",
    renewalDurationMonths: 12,
    ...overrides,
  };
}

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  await RenewalPayment.syncIndexes();
});

beforeEach(clearAllCollections);

describe("recordRenewalPayment", () => {
  it("inserts with processed:false", async () => {
    const row = await recordRenewalPayment(buildPayload({ providerPaymentId: "pay_rec_1" }));
    expect(row.processed).toBe(false);
    expect(row.providerPaymentId).toBe("pay_rec_1");
  });

  it("throws E11000 on duplicate providerPaymentId (idempotency guard)", async () => {
    await recordRenewalPayment(buildPayload({ providerPaymentId: "pay_dup" }));
    await expect(
      recordRenewalPayment(buildPayload({ providerPaymentId: "pay_dup" }))
    ).rejects.toMatchObject({ code: 11000 });
  });
});

describe("getRenewalByProviderPaymentId", () => {
  it("returns the row matching the payment id", async () => {
    await recordRenewalPayment(buildPayload({ providerPaymentId: "pay_get_1" }));
    expect((await getRenewalByProviderPaymentId("pay_get_1"))?.providerPaymentId).toBe(
      "pay_get_1"
    );
    expect(await getRenewalByProviderPaymentId("pay_missing")).toBeNull();
  });
});

describe("claimRenewalPayment + releaseRenewalClaim", () => {
  it("first claim succeeds, second returns null", async () => {
    await recordRenewalPayment(buildPayload({ providerPaymentId: "pay_claim_1" }));

    const first = await claimRenewalPayment("pay_claim_1");
    expect(first).toBeTruthy();
    expect(first?.processed).toBe(true);
    expect(first?.processedAt).toBeDefined();

    const second = await claimRenewalPayment("pay_claim_1");
    expect(second).toBeNull();
  });

  it("release flips processed back to false so the next retry can claim", async () => {
    await recordRenewalPayment(buildPayload({ providerPaymentId: "pay_release_1" }));
    await claimRenewalPayment("pay_release_1");
    await releaseRenewalClaim("pay_release_1");

    const after = await getRenewalByProviderPaymentId("pay_release_1");
    expect(after?.processed).toBe(false);
    expect(after?.processedAt).toBeUndefined();

    // And a fresh claim succeeds.
    expect(await claimRenewalPayment("pay_release_1")).toBeTruthy();
  });
});

describe("attachOrderToRenewal", () => {
  it("crosslinks the renewal row to an Order id", async () => {
    await recordRenewalPayment(buildPayload({ providerPaymentId: "pay_attach_1" }));
    await attachOrderToRenewal("pay_attach_1", "ord_xyz");
    const after = await getRenewalByProviderPaymentId("pay_attach_1");
    expect(after?.orderId).toBe("ord_xyz");
  });
});
