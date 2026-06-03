/**
 * Tests for `@/lib/services/payment/upgrade` (rescan-4 slice 7fe).
 * Hosting-plan upgrade handler — invoked from /verify when
 * razorpay_order_id starts with 'upg_'. Pins:
 *  - getOrderByRazorpayOrderId scoped by orderType:'hosting_upgrade'
 *    (so the regular Order verify path can't accidentally hit this
 *    handler with a non-upgrade order)
 *  - Order not found → 404 'Upgrade order not found'
 *  - **Idempotency guard**: order.status !== 'pending' (i.e. already
 *    processed) → returns success:true WITHOUT re-running the DA flow
 *  - Hosting not found OR plan not found → order.status:'failed' +
 *    saved + 404 response
 *  - **Subscription cancellation BEFORE DA change**: when hosting has
 *    a subscriptionId, RazorpayService.cancelSubscription called +
 *    hosting.subscriptionId cleared + billingType→'manual' + autoRenew→false
 *  - Subscription cancel THROW is NON-FATAL — logs + proceeds with DA
 *    change (the upgrade itself should succeed even if cancel fails)
 *  - daChangePackage outcome.kind !== 'changed' → order.status stays
 *    'paid' (not failed — payment was captured) + domain.status:'failed'
 *    + error stamped with kind + reason + 500 user-facing 'Payment was
 *    captured but the plan change on the server failed' (typed DA error
 *    detail NEVER leaks to user)
 *  - **Happy path**: hosting.planId / .name / .serverPackage updated;
 *    order.status:'completed'; domains[0].status:'registered'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getOrderByRazorpayOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ getOrderByRazorpayOrderId }));

const getHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ getHostingById }));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const daChangePackage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  changePackage: daChangePackage,
}));

const cancelSubscription = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { cancelSubscription },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.unmock("next/server");
const { NextResponse } = await vi.importActual<typeof import("next/server")>(
  "next/server"
);
vi.doMock("next/server", () => ({ NextResponse }));

import { handleUpgradePayment } from "@/lib/services/payment/upgrade";

beforeEach(() => {
  getOrderByRazorpayOrderId.mockReset();
  getHostingById.mockReset();
  getPlanByPlanId.mockReset();
  daChangePackage.mockReset();
  cancelSubscription.mockReset();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeOrder(overrides: Record<string, unknown> = {}): any {
  return {
    _id: "ORD_DOC",
    orderId: "ord_upg_42",
    status: "pending",
    upgradeDetails: {
      hostingId: "HST_1",
      fromPlanId: "starter",
      toPlanId: "plus",
      remainingDays: 200,
    },
    domains: [{ status: "pending" } as Record<string, unknown>],
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeHosting(overrides: Record<string, unknown> = {}): any {
  return {
    _id: "HST_1",
    directAdminUsername: "alice12345",
    domainName: "myhost.com",
    subscriptionId: undefined,
    billingType: "manual",
    autoRenew: false,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const NEW_PLAN = {
  planId: "plus",
  name: "Plus Plan",
  directAdminPackage: "Plus",
};

describe("handleUpgradePayment — pre-checks", () => {
  it("calls getOrderByRazorpayOrderId with orderType:'hosting_upgrade' scope", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(getOrderByRazorpayOrderId).toHaveBeenCalledWith("upg_42", {
      orderType: "hosting_upgrade",
    });
  });

  it("order not found → 404 'Upgrade order not found'", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    const result = await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(result.status).toBe(404);
    const body = await result.json();
    expect(body.error).toMatch(/Upgrade order not found/);
  });

  it("idempotency: order.status !== 'pending' → returns success WITHOUT re-running DA", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(makeOrder({ status: "completed" }));
    const result = await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/already processed/i);
    expect(daChangePackage).not.toHaveBeenCalled();
    expect(getHostingById).not.toHaveBeenCalled();
  });

  it("hosting not found → order.status:'failed' + save + 404", async () => {
    const order = makeOrder();
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    getHostingById.mockResolvedValueOnce(null);
    const result = await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(result.status).toBe(404);
    expect(order.status).toBe("failed");
    expect(order.save).toHaveBeenCalled();
    expect(daChangePackage).not.toHaveBeenCalled();
  });

  it("plan not found → order.status:'failed' + 404", async () => {
    const order = makeOrder();
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    getHostingById.mockResolvedValueOnce(makeHosting());
    getPlanByPlanId.mockResolvedValueOnce(null);
    const result = await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(result.status).toBe(404);
    expect(order.status).toBe("failed");
  });
});

describe("handleUpgradePayment — subscription cancellation pre-DA-change", () => {
  it("hosting.subscriptionId present → cancelSubscription called + hosting fields cleared", async () => {
    const order = makeOrder();
    const hosting = makeHosting({
      subscriptionId: "sub_xyz",
      billingType: "subscription",
      autoRenew: true,
    });
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    getHostingById.mockResolvedValueOnce(hosting);
    getPlanByPlanId.mockResolvedValueOnce(NEW_PLAN);
    cancelSubscription.mockResolvedValueOnce({});
    daChangePackage.mockResolvedValueOnce({ kind: "changed" });
    await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(cancelSubscription).toHaveBeenCalledWith("sub_xyz");
    expect(hosting.subscriptionId).toBeUndefined();
    expect(hosting.billingType).toBe("manual");
    expect(hosting.autoRenew).toBe(false);
  });

  it("no subscriptionId → cancelSubscription NOT called", async () => {
    const order = makeOrder();
    const hosting = makeHosting(); // no subscriptionId
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    getHostingById.mockResolvedValueOnce(hosting);
    getPlanByPlanId.mockResolvedValueOnce(NEW_PLAN);
    daChangePackage.mockResolvedValueOnce({ kind: "changed" });
    await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it("cancelSubscription throw is NON-FATAL — proceeds with DA change", async () => {
    const order = makeOrder();
    const hosting = makeHosting({
      subscriptionId: "sub_xyz",
      billingType: "subscription",
      autoRenew: true,
    });
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    getHostingById.mockResolvedValueOnce(hosting);
    getPlanByPlanId.mockResolvedValueOnce(NEW_PLAN);
    cancelSubscription.mockRejectedValueOnce(new Error("Razorpay 502"));
    daChangePackage.mockResolvedValueOnce({ kind: "changed" });
    const result = await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(daChangePackage).toHaveBeenCalled();
    expect(result.status).toBe(200);
    // hosting subscriptionId still cleared (cancellation intent honoured locally)
    expect(hosting.subscriptionId).toBeUndefined();
    expect(hosting.billingType).toBe("manual");
  });
});

describe("handleUpgradePayment — daChangePackage outcome dispatch", () => {
  it("'changed' (happy path): order.status:'completed' + domain status:'registered' + hosting updated", async () => {
    const order = makeOrder();
    const hosting = makeHosting();
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    getHostingById.mockResolvedValueOnce(hosting);
    getPlanByPlanId.mockResolvedValueOnce(NEW_PLAN);
    daChangePackage.mockResolvedValueOnce({ kind: "changed" });
    const result = await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.success).toBe(true);
    expect(order.status).toBe("completed");
    expect(order.domains[0].status).toBe("registered");
    expect(hosting.planId).toBe("plus");
    expect(hosting.name).toBe("Plus Plan");
    expect(hosting.serverPackage).toBe("Plus");
    expect(hosting.save).toHaveBeenCalled();
  });

  it("non-'changed' outcome → status:'paid' (NOT failed — payment captured) + domain failed + 500 with GENERIC user msg", async () => {
    const order = makeOrder();
    const hosting = makeHosting();
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    getHostingById.mockResolvedValueOnce(hosting);
    getPlanByPlanId.mockResolvedValueOnce(NEW_PLAN);
    daChangePackage.mockResolvedValueOnce({
      kind: "user_not_found",
      reason: "DA reported user pawan42 does not exist",
    });
    const result = await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(result.status).toBe(500);
    expect(order.status).toBe("paid"); // payment was captured
    expect(order.domains[0].status).toBe("failed");
    expect(order.domains[0].error).toMatch(/user_not_found/);
    expect(order.domains[0].error).toMatch(/pawan42/);
    // User-facing message: GENERIC — DA internal detail must not leak
    const body = await result.json();
    expect(body.error).toMatch(/Payment was captured but the plan change on the server failed/);
    expect(body.error).not.toMatch(/pawan42/);
    expect(body.error).not.toMatch(/user_not_found/);
  });

  it("'package_not_found' outcome → also 500 + paid + GENERIC message", async () => {
    const order = makeOrder();
    const hosting = makeHosting();
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    getHostingById.mockResolvedValueOnce(hosting);
    getPlanByPlanId.mockResolvedValueOnce(NEW_PLAN);
    daChangePackage.mockResolvedValueOnce({
      kind: "package_not_found",
      reason: "Package 'Plus' missing on server",
    });
    const result = await handleUpgradePayment("upg_42", "pay_xyz", "sig");
    expect(result.status).toBe(500);
    expect(order.domains[0].error).toMatch(/package_not_found/);
  });

  it("payment fields stamped on order BEFORE the DA call (preserves audit trail even on DA fail)", async () => {
    const order = makeOrder();
    const hosting = makeHosting();
    getOrderByRazorpayOrderId.mockResolvedValueOnce(order);
    getHostingById.mockResolvedValueOnce(hosting);
    getPlanByPlanId.mockResolvedValueOnce(NEW_PLAN);
    // Make DA fail to confirm payment fields are kept even then.
    daChangePackage.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "unknown",
    });
    await handleUpgradePayment("upg_42", "pay_xyz", "sig_xyz");
    expect(order.razorpayPaymentId).toBe("pay_xyz");
    expect(order.razorpaySignature).toBe("sig_xyz");
  });
});
