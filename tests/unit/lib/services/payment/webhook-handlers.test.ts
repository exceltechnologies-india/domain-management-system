/**
 * Tests for `@/lib/services/payment/webhook-handlers` (rescan-4
 * slice 7fi). Razorpay subscription.charged + subscription.payment_failed
 * webhook handlers. Pins:
 *  - **Missing userId or domainName in notes → early return**
 *    (no idempotency anchor possible without these — webhook is
 *    silently dropped)
 *  - **Hosting not found at step 1 → ADMIN ALERT email + return**
 *    (customer was charged but no Hosting record exists; manual
 *    refund or create required); alert email failure is swallowed
 *  - **recordRenewalPayment E11000 (dupe key) IS EXPECTED** on retries
 *    — flow continues to the idempotency check; other write errors →
 *    return (caller's webhook retry will hit it again)
 *  - **Idempotency: claimRenewalPayment returns null when another
 *    worker already won the claim** → skip the rest
 *  - **Renewal logic (Payment Always Wins)**:
 *    - wasInactive (expired/failed/terminated) → hard reset expiry to
 *      now + 1 month (isMonthly) OR + 1 year (yearly); unsuspend DA
 *      only when status === 'expired' (not 'failed'/'terminated' —
 *      those branches have no DA account to unsuspend)
 *    - else (active/expiring_soon) → add-on extend from existing
 *      expiryDate
 *  - **Trial → paid transition**: hosting.isTrial → flip to false +
 *    HARD-RESET expiry to now+1yr (the trial's 15-day expiry MUST
 *    NOT be the base — 15-day add-on would be a regression)
 *  - hosting.status:'active' + last_reminder_sent:null +
 *    processing_until:null reset; next_action_at = expiry - 15d
 *  - **createRenewalOrder failure NON-CRITICAL** (service already
 *    renewed — audit gap only); attachOrderToRenewal NOT called when
 *    Order creation failed
 *  - **Zoho sync is fire-and-forget** via createHttpTask — failure
 *    logged + flow continues (Cloud Tasks handles retries; service
 *    activation never depends on Zoho)
 *  - handleSubscriptionFailed: status:'expired' + billingType:'manual'
 *    + next_action_at:undefined; **da suspend called** (typed outcome
 *    logged inside wrapper, callsite continues regardless — DB is the
 *    source of truth)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const getPlanByRazorpaySubscriptionPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({
  getPlanByRazorpaySubscriptionPlanId,
}));

const findUserHosting = vi.hoisted(() => vi.fn());
const getHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({
  findUserHosting,
  getHostingById,
}));

const createRenewalOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ createRenewalOrder }));

const attachOrderToRenewal = vi.hoisted(() => vi.fn());
const claimRenewalPayment = vi.hoisted(() => vi.fn());
const getRenewalByProviderPaymentId = vi.hoisted(() => vi.fn());
const recordRenewalPayment = vi.hoisted(() => vi.fn());
const releaseRenewalClaim = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/renewal-payments", () => ({
  attachOrderToRenewal,
  claimRenewalPayment,
  getRenewalByProviderPaymentId,
  recordRenewalPayment,
  releaseRenewalClaim,
}));

const sendAdminNotification = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendAdminNotification },
}));

const createHttpTask = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cloud-tasks", () => ({ createHttpTask }));

const daSuspendUser = vi.hoisted(() => vi.fn());
const daUnsuspendUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  suspendUser: daSuspendUser,
  unsuspendUser: daUnsuspendUser,
}));

vi.mock("@/models/Hosting", () => ({ default: { findOne: vi.fn() } }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  handleSubscriptionCharged,
  handleSubscriptionFailed,
} from "@/lib/services/payment/webhook-handlers";

function payload(overrides: {
  paymentAmount?: number;
  userId?: string | null;
  domainName?: string | null;
  planId?: string;
  subscriptionId?: string;
  paymentId?: string;
} = {}): never {
  // null sentinel means "omit field"; undefined means "use default".
  const notes: Record<string, string | undefined> = {};
  if (overrides.userId !== null) notes.user_id = overrides.userId ?? "USER_ID";
  if (overrides.domainName !== null) {
    notes.domain_name = overrides.domainName ?? "x.com";
  }
  return {
    payload: {
      payment: {
        entity: {
          id: overrides.paymentId ?? "pay_xyz",
          amount: overrides.paymentAmount ?? 50000,
          currency: "INR",
        },
      },
      subscription: {
        entity: {
          id: overrides.subscriptionId ?? "sub_xyz",
          plan_id: overrides.planId ?? "plan_rzp_starter_monthly",
          notes,
        },
      },
    },
  } as never;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeHosting(overrides: Record<string, unknown> = {}): any {
  return {
    _id: "HST_1",
    domainName: "x.com",
    directAdminUsername: "alice",
    status: "active",
    expiryDate: new Date("2027-01-01"),
    isTrial: false,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const PLAN_MONTHLY = {
  planId: "starter",
  name: "Starter",
  directAdminPackage: "Starter",
  razorpayPlans: {
    monthly: "plan_rzp_starter_monthly",
    yearly: "plan_rzp_starter_yearly",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default mocks for happy-path
  getPlanByRazorpaySubscriptionPlanId.mockResolvedValue(PLAN_MONTHLY);
  findUserHosting.mockResolvedValue(makeHosting());
  recordRenewalPayment.mockResolvedValue(undefined);
  getRenewalByProviderPaymentId.mockResolvedValue({
    _id: "RNW_1",
    serviceId: "HST_1",
    processed: false,
  });
  claimRenewalPayment.mockResolvedValue({ _id: "RNW_1", serviceId: "HST_1" });
  getHostingById.mockResolvedValue(makeHosting());
  getUserById.mockResolvedValue({
    _id: "USER_ID",
    email: "u@x.test",
    firstName: "Alice",
  });
  createRenewalOrder.mockResolvedValue({ _id: "ORD_RNW_1" });
  attachOrderToRenewal.mockResolvedValue(undefined);
  createHttpTask.mockResolvedValue(undefined);
  daUnsuspendUser.mockResolvedValue({ kind: "unsuspended" });
  daSuspendUser.mockResolvedValue({ kind: "suspended" });
  sendAdminNotification.mockResolvedValue(undefined);
});

describe("handleSubscriptionCharged — early returns", () => {
  it("missing userId in notes → early return (no work)", async () => {
    await handleSubscriptionCharged(payload({ userId: null }));
    expect(getPlanByRazorpaySubscriptionPlanId).not.toHaveBeenCalled();
    expect(recordRenewalPayment).not.toHaveBeenCalled();
  });

  it("missing domainName in notes → early return", async () => {
    await handleSubscriptionCharged(payload({ domainName: null }));
    expect(recordRenewalPayment).not.toHaveBeenCalled();
  });

  it("HOSTING NOT FOUND → admin alert email + return (no claim, no save)", async () => {
    findUserHosting.mockResolvedValueOnce(null);
    await handleSubscriptionCharged(payload());
    expect(sendAdminNotification).toHaveBeenCalled();
    const [, subject] = sendAdminNotification.mock.calls[0];
    expect(subject).toMatch(/Hosting not found/);
    expect(recordRenewalPayment).not.toHaveBeenCalled();
    expect(claimRenewalPayment).not.toHaveBeenCalled();
  });

  it("admin alert email throw is SWALLOWED", async () => {
    findUserHosting.mockResolvedValueOnce(null);
    sendAdminNotification.mockRejectedValueOnce(new Error("SMTP down"));
    await expect(handleSubscriptionCharged(payload())).resolves.toBeUndefined();
  });
});

describe("handleSubscriptionCharged — RenewalPayment idempotency", () => {
  it("recordRenewalPayment E11000 dupe-key → continues to idempotency check (expected on retries)", async () => {
    const dupErr: { code: number; message: string } = {
      code: 11000,
      message: "dup",
    };
    recordRenewalPayment.mockRejectedValueOnce(dupErr);
    await handleSubscriptionCharged(payload());
    // Flow continues — claim was attempted.
    expect(claimRenewalPayment).toHaveBeenCalled();
  });

  it("recordRenewalPayment non-E11000 error → early return (don't claim)", async () => {
    recordRenewalPayment.mockRejectedValueOnce(new Error("network down"));
    await handleSubscriptionCharged(payload());
    expect(claimRenewalPayment).not.toHaveBeenCalled();
  });

  it("renewal.processed === true → skip (already handled)", async () => {
    getRenewalByProviderPaymentId.mockResolvedValueOnce({
      _id: "RNW_1",
      serviceId: "HST_1",
      processed: true,
    });
    await handleSubscriptionCharged(payload());
    expect(claimRenewalPayment).not.toHaveBeenCalled();
  });

  it("claimRenewalPayment returns null (another worker won) → skip rest of flow", async () => {
    claimRenewalPayment.mockResolvedValueOnce(null);
    await handleSubscriptionCharged(payload());
    expect(getHostingById).not.toHaveBeenCalled();
    expect(createRenewalOrder).not.toHaveBeenCalled();
  });

  it("hosting or user MISSING after claim → release claim + return (retry will pick up)", async () => {
    getHostingById.mockResolvedValueOnce(null);
    await handleSubscriptionCharged(payload());
    expect(releaseRenewalClaim).toHaveBeenCalledWith("pay_xyz");
    expect(createRenewalOrder).not.toHaveBeenCalled();
  });
});

describe("handleSubscriptionCharged — renewal logic (Payment Always Wins)", () => {
  it("monthly plan detection: plan_id matches razorpayPlans.monthly → +1 month extension", async () => {
    const hosting = makeHosting({
      status: "active",
      expiryDate: new Date("2027-01-01T00:00:00Z"),
    });
    getHostingById.mockResolvedValueOnce(hosting);
    await handleSubscriptionCharged(
      payload({ planId: "plan_rzp_starter_monthly" })
    );
    // add-on: extend from 2027-01-01 by 1 month → 2027-02-01
    expect(hosting.expiryDate.getUTCFullYear()).toBe(2027);
    expect(hosting.expiryDate.getUTCMonth()).toBe(1); // Feb
  });

  it("yearly plan detection: plan_id NOT matching .monthly → +1 year extension", async () => {
    const hosting = makeHosting({
      status: "active",
      expiryDate: new Date("2027-01-01T00:00:00Z"),
    });
    getHostingById.mockResolvedValueOnce(hosting);
    await handleSubscriptionCharged(
      payload({ planId: "plan_rzp_starter_yearly" })
    );
    expect(hosting.expiryDate.getUTCFullYear()).toBe(2028);
  });

  it("wasInactive (expired) → HARD RESET expiry from now + DA unsuspend called", async () => {
    const hosting = makeHosting({
      status: "expired",
      expiryDate: new Date("2025-01-01"),
      directAdminUsername: "alice",
    });
    getHostingById.mockResolvedValueOnce(hosting);
    await handleSubscriptionCharged(payload());
    // Expiry reset from NOW (not the stale 2025 date)
    expect(hosting.expiryDate.getTime()).toBeGreaterThan(Date.now() - 60000);
    expect(daUnsuspendUser).toHaveBeenCalledWith({ username: "alice" });
  });

  it("wasInactive 'failed' → HARD RESET but NO daUnsuspend (only 'expired' status triggers unsuspend)", async () => {
    const hosting = makeHosting({
      status: "failed",
      expiryDate: new Date("2025-01-01"),
      directAdminUsername: "alice",
    });
    getHostingById.mockResolvedValueOnce(hosting);
    await handleSubscriptionCharged(payload());
    expect(daUnsuspendUser).not.toHaveBeenCalled();
    // But expiry still reset to future
    expect(hosting.expiryDate.getTime()).toBeGreaterThan(Date.now() - 60000);
  });

  it("**Trial → paid transition**: isTrial flipped + expiry HARD-RESET to now+1yr (NOT 15-day-add-on regression)", async () => {
    const hosting = makeHosting({
      status: "active",
      isTrial: true,
      expiryDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days from now (trial)
    });
    getHostingById.mockResolvedValueOnce(hosting);
    await handleSubscriptionCharged(
      payload({ planId: "plan_rzp_starter_yearly" })
    );
    expect(hosting.isTrial).toBe(false);
    // Expiry should be ~1 year from now, NOT ~14 days + 1 year (the add-on would be ~1y14d)
    const expectedExpiry = new Date();
    expectedExpiry.setFullYear(expectedExpiry.getFullYear() + 1);
    const diffDays = Math.abs(
      (hosting.expiryDate.getTime() - expectedExpiry.getTime()) / (24 * 60 * 60 * 1000)
    );
    expect(diffDays).toBeLessThan(1); // within 1 day of expected
  });

  it("hosting status:'active' + cleared lifecycle fields + paymentId/subscriptionId stamped", async () => {
    const hosting = makeHosting({
      status: "active",
      last_reminder_sent: new Date("2026-01-01"),
      processing_until: new Date("2026-06-01"),
    });
    getHostingById.mockResolvedValueOnce(hosting);
    await handleSubscriptionCharged(payload());
    expect(hosting.status).toBe("active");
    expect(hosting.last_reminder_sent).toBeNull();
    expect(hosting.processing_until).toBeNull();
    expect(hosting.paymentId).toBe("pay_xyz");
    expect(hosting.subscriptionId).toBe("sub_xyz");
    expect(hosting.save).toHaveBeenCalled();
  });

  it("next_action_at = newExpiry - 15 days (renewal reminder cron pre-stamp)", async () => {
    const hosting = makeHosting({
      status: "active",
      expiryDate: new Date("2027-01-01T00:00:00Z"),
    });
    getHostingById.mockResolvedValueOnce(hosting);
    await handleSubscriptionCharged(payload());
    const reminderTime = hosting.expiryDate.getTime() - 15 * 24 * 60 * 60 * 1000;
    expect(hosting.next_action_at.getTime()).toBe(reminderTime);
  });
});

describe("handleSubscriptionCharged — Order audit-trail + Zoho fire-and-forget", () => {
  it("createRenewalOrder called + attachOrderToRenewal links the Order to the RenewalPayment", async () => {
    await handleSubscriptionCharged(payload());
    expect(createRenewalOrder).toHaveBeenCalled();
    expect(attachOrderToRenewal).toHaveBeenCalledWith("pay_xyz", "ORD_RNW_1");
  });

  it("createRenewalOrder THROW is NON-CRITICAL (service already renewed) — attachOrderToRenewal NOT called", async () => {
    createRenewalOrder.mockRejectedValueOnce(new Error("save conflict"));
    await handleSubscriptionCharged(payload());
    expect(attachOrderToRenewal).not.toHaveBeenCalled();
    // Flow continues anyway, but Zoho task ALSO won't fire (no newOrder).
    expect(createHttpTask).not.toHaveBeenCalled();
  });

  it("Zoho task: createHttpTask fire-and-forget after Order created", async () => {
    await handleSubscriptionCharged(payload());
    expect(createHttpTask).toHaveBeenCalled();
    const [queue, , payloadArg] = createHttpTask.mock.calls[0];
    expect(typeof queue).toBe("string");
    expect(payloadArg.orderId).toBe("ORD_RNW_1");
    expect(payloadArg.serviceType).toBe("hosting");
    expect(payloadArg.amount).toBe(500); // 50000 paise → 500 rupees
  });

  it("createHttpTask failure SWALLOWED (Cloud Tasks retries — service activation never depends on Zoho)", async () => {
    createHttpTask.mockRejectedValueOnce(new Error("queue offline"));
    await expect(handleSubscriptionCharged(payload())).resolves.toBeUndefined();
  });
});

describe("handleSubscriptionFailed — immediate expiration", () => {
  it("missing userId/domainName → early return", async () => {
    await handleSubscriptionFailed(payload({ userId: null }));
    expect(findUserHosting).not.toHaveBeenCalled();
  });

  it("hosting not found → silent return (no error, no save)", async () => {
    findUserHosting.mockResolvedValueOnce(null);
    await handleSubscriptionFailed(payload());
    expect(daSuspendUser).not.toHaveBeenCalled();
  });

  it("happy: status:'expired' + billingType:'manual' + next_action_at:undefined + DA suspend", async () => {
    const hosting = makeHosting({ directAdminUsername: "alice" });
    findUserHosting.mockResolvedValueOnce(hosting);
    await handleSubscriptionFailed(payload());
    expect(hosting.status).toBe("expired");
    expect(hosting.billingType).toBe("manual");
    expect(hosting.next_action_at).toBeUndefined();
    expect(hosting.save).toHaveBeenCalled();
    expect(daSuspendUser).toHaveBeenCalledWith({ username: "alice" });
  });

  it("hosting without DA username → save still proceeds, DA suspend NOT called", async () => {
    const hosting = makeHosting({ directAdminUsername: undefined });
    findUserHosting.mockResolvedValueOnce(hosting);
    await handleSubscriptionFailed(payload());
    expect(hosting.status).toBe("expired");
    expect(daSuspendUser).not.toHaveBeenCalled();
  });

  it("all errors caught (try/catch wraps entire body) — handler always resolves", async () => {
    findUserHosting.mockRejectedValueOnce(new Error("db down"));
    await expect(handleSubscriptionFailed(payload())).resolves.toBeUndefined();
  });
});
