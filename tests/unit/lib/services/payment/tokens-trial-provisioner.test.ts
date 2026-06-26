/**
 * Tests for `lib/services/payment/tokens-trial-provisioner.ts` (Phase 2C).
 *
 * createTokensFlowTrialHosting creates a Hosting row from a Tokens-mode
 * CIT-authorized Order. Coverage:
 *  - Happy path: all required fields populated; expiry = now + 15 days
 *  - Refuses when order.mandateMode !== 'tokens' (defensive guard)
 *  - Refuses when razorpayCustomerId or razorpayTokenId missing on order
 *  - Refuses when domains[0] is malformed (no domainName / no planId)
 *  - status='pending' (NOT 'active') — DA provisioning is a later phase
 *  - razorpayCustomerId + razorpayTokenId + isTrial + autoRenew + billingType
 *    fields propagate from order to Hosting correctly
 *
 * The createHosting helper is mocked at module boundary so we assert on
 * the exact payload built by the provisioner. No MongoDB involved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ createHosting }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createTokensFlowTrialHosting } from "@/lib/services/payment/tokens-trial-provisioner";

function makeOrder(over: Record<string, unknown> = {}) {
  return {
    orderId: "ORD-T-1",
    userId: "U1",
    mandateMode: "tokens",
    razorpayCustomerId: "cust_T",
    razorpayTokenId: "token_T",
    razorpayPaymentId: "pay_T",
    domains: [
      {
        domainName: "trial.example.com",
        hostingPlan: { planId: "starter", name: "Starter", serverPackage: "Starter" },
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  createHosting
    .mockReset()
    .mockResolvedValue({ _id: "host_NEW" });
});

describe("createTokensFlowTrialHosting", () => {
  it("happy path: creates Hosting with status='pending', isTrial=true, expiry now+15d, tokens fields populated", async () => {
    const before = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await createTokensFlowTrialHosting(makeOrder() as any);
    const after = Date.now();

    expect(result.hostingId).toBe("host_NEW");
    expect(result.domainName).toBe("trial.example.com");
    expect(result.status).toBe("pending");

    expect(createHosting).toHaveBeenCalledTimes(1);
    const payload = createHosting.mock.calls[0][0];

    // Status + trial flag + autoRenew + billingType
    expect(payload.status).toBe("pending");
    expect(payload.isTrial).toBe(true);
    expect(payload.autoRenew).toBe(true);
    expect(payload.billingType).toBe("subscription");

    // Tokens-flow fields propagated
    expect(payload.razorpayCustomerId).toBe("cust_T");
    expect(payload.razorpayTokenId).toBe("token_T");
    expect(payload.paymentId).toBe("pay_T");

    // No Razorpay subscription_id in Tokens flow
    expect(payload.subscriptionId).toBeUndefined();

    // Expiry is approximately now + 15 days
    const expiry = (payload.expiryDate as Date).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 14.9 * 24 * 60 * 60 * 1000);
    expect(expiry).toBeLessThanOrEqual(after + 15.1 * 24 * 60 * 60 * 1000);

    // next_action_at is 2 days before expiry (reminder)
    const reminder = (payload.next_action_at as Date).getTime();
    expect(expiry - reminder).toBeCloseTo(2 * 24 * 60 * 60 * 1000, -4); // ms-level slack

    // Plan info propagated
    expect(payload.planId).toBe("starter");
    expect(payload.name).toBe("Starter");
    expect(payload.serverPackage).toBe("Starter");

    // DA username starts empty (Phase 2D cron fills it in)
    expect(payload.directAdminUsername).toBe("");
  });

  it("refuses if mandateMode is not 'tokens' (defensive guard)", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createTokensFlowTrialHosting(makeOrder({ mandateMode: "subscription" }) as any)
    ).rejects.toThrow(/mandateMode is 'subscription'/);
    expect(createHosting).not.toHaveBeenCalled();
  });

  it("refuses if razorpayCustomerId is missing", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createTokensFlowTrialHosting(makeOrder({ razorpayCustomerId: undefined }) as any)
    ).rejects.toThrow(/missing razorpayCustomerId/);
    expect(createHosting).not.toHaveBeenCalled();
  });

  it("refuses if razorpayTokenId is missing", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createTokensFlowTrialHosting(makeOrder({ razorpayTokenId: undefined }) as any)
    ).rejects.toThrow(/missing.*razorpayTokenId/);
    expect(createHosting).not.toHaveBeenCalled();
  });

  it("refuses if domains[0] has no domainName", async () => {
    await expect(
      createTokensFlowTrialHosting(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeOrder({ domains: [{ hostingPlan: { planId: "starter" } }] }) as any
      )
    ).rejects.toThrow(/no hosting item with planId in domains\[0\]/);
    expect(createHosting).not.toHaveBeenCalled();
  });

  it("refuses if domains[0] has no planId", async () => {
    await expect(
      createTokensFlowTrialHosting(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeOrder({ domains: [{ domainName: "x.com", hostingPlan: {} }] }) as any
      )
    ).rejects.toThrow(/no hosting item with planId/);
    expect(createHosting).not.toHaveBeenCalled();
  });

  it("falls back to planId for serverPackage when it's not set explicitly", async () => {
    await createTokensFlowTrialHosting(
      makeOrder({
        domains: [
          {
            domainName: "x.com",
            hostingPlan: { planId: "starter", name: "Starter" },
            // no serverPackage
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    );
    const payload = createHosting.mock.calls[0][0];
    expect(payload.serverPackage).toBe("starter"); // fallback to planId
  });
});
