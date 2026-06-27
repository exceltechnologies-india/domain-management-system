/**
 * Tests for `lib/services/payment/manual-trial-provisioner.ts`.
 *
 * The manual provisioner creates a Hosting row for a customer who
 * signed up via the "no-mandate" trial path (HOSTING_MANDATE_FLOW=manual).
 * Unlike the Tokens-flow provisioner (which fires asynchronously from
 * the webhook handler after a CIT auth refund), this one fires inline
 * from create-order at signup time.
 *
 * Pins:
 *  - billingType='manual' (NOT 'subscription')
 *  - autoRenew=false (manual mode means customer chooses when to pay)
 *  - isTrial=true
 *  - status='pending' (DA provisioning cron picks it up)
 *  - expiryDate = now + 15 days (trial duration)
 *  - next_action_at = expiryDate - 2 days (renewal reminder cron)
 *  - directAdminUsername = empty string (DA cron overwrites)
 *  - No Razorpay fields set (razorpayTokenId, subscriptionId — all undefined)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({
  createHosting,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createManualFlowTrialHosting } from "@/lib/services/payment/manual-trial-provisioner";

beforeEach(() => {
  createHosting.mockReset().mockResolvedValue({
    _id: { toString: () => "H_MANUAL_1" },
  });
});

describe("createManualFlowTrialHosting", () => {
  it("creates Hosting with billingType='manual' + autoRenew=false + no Razorpay fields", async () => {
    await createManualFlowTrialHosting({
      userId: "U1",
      domainName: "example.com",
      planId: "starter",
      planName: "Starter Yearly",
      orderId: "ord_manual_1",
    });

    expect(createHosting).toHaveBeenCalledTimes(1);
    const args = createHosting.mock.calls[0][0];

    // Manual-flow discriminator fields
    expect(args.billingType).toBe("manual");
    expect(args.autoRenew).toBe(false); // customer pays when ready, not auto

    // No Razorpay fields — that's the whole point of manual mode
    expect(args.razorpayTokenId).toBeUndefined();
    expect(args.razorpayCustomerId).toBeUndefined();
    expect(args.subscriptionId).toBeUndefined();

    // Standard fields
    expect(args.userId).toBe("U1");
    expect(args.domainName).toBe("example.com");
    expect(args.planId).toBe("starter");
    expect(args.orderId).toBe("ord_manual_1");
    expect(args.isTrial).toBe(true);
    expect(args.status).toBe("pending");
    expect(args.directAdminUsername).toBe(""); // DA cron overwrites
  });

  it("sets expiryDate = now + 15 days", async () => {
    const before = Date.now();
    await createManualFlowTrialHosting({
      userId: "U1",
      domainName: "x.com",
      planId: "starter",
      planName: "Starter",
      orderId: "ord_x",
    });
    const after = Date.now();

    const args = createHosting.mock.calls[0][0];
    const expiry = args.expiryDate.getTime();
    const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;

    expect(expiry).toBeGreaterThanOrEqual(before + fifteenDaysMs - 1000);
    expect(expiry).toBeLessThanOrEqual(after + fifteenDaysMs + 1000);
  });

  it("sets next_action_at = expiryDate - 2 days (renewal-reminder cron pickup)", async () => {
    await createManualFlowTrialHosting({
      userId: "U1",
      domainName: "x.com",
      planId: "starter",
      planName: "Starter",
      orderId: "ord_x",
    });

    const args = createHosting.mock.calls[0][0];
    const reminderMs = args.next_action_at.getTime();
    const expiryMs = args.expiryDate.getTime();
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

    // Reminder fires 2 days before expiry — gives the customer time to
    // pay before service lapses.
    expect(expiryMs - reminderMs).toBeCloseTo(twoDaysMs, -3);
  });

  it("returns hostingId + domainName + expiryDate + status", async () => {
    const result = await createManualFlowTrialHosting({
      userId: "U1",
      domainName: "rv.example.com",
      planId: "starter",
      planName: "Starter",
      orderId: "ord_rv",
    });

    expect(result.hostingId).toBe("H_MANUAL_1");
    expect(result.domainName).toBe("rv.example.com");
    expect(result.status).toBe("pending");
    expect(result.expiryDate).toBeInstanceOf(Date);
  });

  it("falls back planName to 'Hosting Plan' + serverPackage to planId when caller omits them", async () => {
    await createManualFlowTrialHosting({
      userId: "U1",
      domainName: "x.com",
      planId: "starter",
      planName: "", // empty
      orderId: "ord_x",
    });

    const args = createHosting.mock.calls[0][0];
    expect(args.name).toBe("Hosting Plan");
    expect(args.serverPackage).toBe("starter"); // falls back to planId
  });

  it("uses provided serverPackage when caller passes one", async () => {
    await createManualFlowTrialHosting({
      userId: "U1",
      domainName: "x.com",
      planId: "starter",
      planName: "Starter",
      serverPackage: "starter_da_package",
      orderId: "ord_x",
    });

    const args = createHosting.mock.calls[0][0];
    expect(args.serverPackage).toBe("starter_da_package");
  });

  it("propagates errors from createHosting (caller handles)", async () => {
    createHosting.mockRejectedValueOnce(new Error("Mongo write failed"));
    await expect(
      createManualFlowTrialHosting({
        userId: "U1",
        domainName: "x.com",
        planId: "starter",
        planName: "Starter",
        orderId: "ord_x",
      })
    ).rejects.toThrow("Mongo write failed");
  });
});
