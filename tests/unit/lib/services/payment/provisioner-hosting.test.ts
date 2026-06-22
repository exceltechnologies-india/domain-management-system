/**
 * Tests for `@/lib/services/payment/provisioner-hosting` (rescan-4
 * slice 7fc). Per-item hosting provisioner — DA-user creation +
 * Hosting record + PendingHosting fallback. Pins:
 *  - **3-attempt username candidate pre-generation** (crypto.randomBytes(4)
 *    suffix; DA-safe lowercased alphanumeric prefix from domain); list
 *    handed verbatim to daCreateUser
 *  - daCreateUser 'created' → captures returned username; 'username_collision_exhausted'
 *    → throws (rare — username generator collided 3× against existing DA
 *    accounts); **'da_unreachable' → throws with `__daUnreachable:true`
 *    + status:503 attached** (signals handler to route to PendingHosting
 *    pending state for cron retry); 'hard_failure' → plain throw
 *  - resolveDaPackageName 4-step fallback chain: hostingPlan.serverPackage
 *    → name-based inference (starter/standard/plus) → price-based
 *    (PRICE_TO_PACKAGE from HOSTING_PLANS) → DA_DEFAULT_PACKAGE env →
 *    literal 'Starter'
 *  - **Trial items: ALWAYS 15-day expiry** regardless of caller's
 *    registrationPeriod/periodUnit (defence vs misconfigured trial
 *    item being treated as paid)
 *  - non-trial periodUnit normalisation: 'years' or undefined → 'months'
 *    (the hosting-plan stored period); 'days'/'minutes' pass through
 *  - **Hosting record next_action_at = expiresAt - FIRST_REMINDER_DAYS×24h**
 *    (renewal-reminder cron pre-stamp); autoRenew + billingType keyed on
 *    razorpay_subscription_id presence
 *  - setUserDirectAdminUsername mutation BEFORE Hosting.create so
 *    subsequent items can reuse the existing DA user
 *  - sendHostingProvisionedEmail FAILURE SWALLOWED (logged + continue)
 *  - createHosting FAILURE SWALLOWED (logged + continue — DA is the
 *    source of truth, local row can be reconciled later)
 *  - **handleHostingProvisionError**: DA-unreachable → status:'pending' +
 *    'queued ... temporarily unavailable' user message + PendingHosting
 *    with status:'pending'; everything else → status:'failed' +
 *    generic 'team has been notified' message + PendingHosting
 *    status:'failed'; raw error.message stays in PendingHosting +
 *    serverLogger but NEVER reaches user
 *  - DA-unreachable bookingStep = 'hosting_deferred' + progress:50;
 *    hard-failure step = 'domain_failed' + progress:100
 *  - createPendingHosting failure SWALLOWED (logged + still returns
 *    the error result — admin can still see the orderDomain.error)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const daCreateUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  createUser: daCreateUser,
}));

vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { NAMESERVERS: ["ns1.test", "ns2.test"] },
  DA_SERVER_IP: "10.0.0.1",
}));

const sendHostingProvisionedEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendHostingProvisionedEmail },
}));

const setUserDirectAdminUsername = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  setUserDirectAdminUsername,
}));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const createHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ createHosting }));

const createPendingHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-hostings", () => ({ createPendingHosting }));

const calculateHostingDates = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hosting-dates", () => ({ calculateHostingDates }));

vi.mock("@/config/hosting-plans", () => ({
  HOSTING_PLANS: {
    starter: { price: 99, serverPackage: "Starter" },
    standard: { price: 199, serverPackage: "Standard" },
    plus: { price: 399, serverPackage: "Plus" },
  },
}));

vi.mock("@/config/automation", () => ({
  AUTOMATION_CONFIG: { REMINDER_DAYS: [30, 14, 7, 1] },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { provisionHostingItem } from "@/lib/services/payment/provisioner-hosting";

const CTX: Record<string, unknown> = {
  user: { _id: "USER_ID", email: "u@x.test", firstName: "Alice" },
  orderId: "ord_42",
  razorpay_payment_id: "pay_xyz",
  razorpay_subscription_id: undefined,
  customerResult: { customerId: 7, contactId: 100 },
};

const ITEM = {
  domainName: "myhost.com",
  itemType: "hosting",
  price: 199,
  currency: "INR",
  registrationPeriod: 12,
  periodUnit: "months",
  hostingPlan: { name: "Standard", serverPackage: "Standard" },
} as Record<string, unknown>;

const REGISTERED_AT = new Date("2026-06-01");
const EXPIRES_AT = new Date("2027-06-01");

beforeEach(() => {
  daCreateUser.mockReset();
  sendHostingProvisionedEmail.mockReset();
  sendHostingProvisionedEmail.mockResolvedValue(undefined);
  setUserDirectAdminUsername.mockReset();
  getPlanByPlanId.mockReset();
  createHosting.mockReset();
  createPendingHosting.mockReset();
  calculateHostingDates.mockReset();
  calculateHostingDates.mockReturnValue({
    registeredAt: REGISTERED_AT,
    expiresAt: EXPIRES_AT,
  });
});

describe("provisionHostingItem — username candidate generation + DA call", () => {
  it("3 candidates pre-generated with lowercased alnum prefix + 5-hex suffix", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "myhostABCDE" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(ITEM as never, CTX as never);
    const [args] = daCreateUser.mock.calls[0];
    expect(args.usernameCandidates).toHaveLength(3);
    args.usernameCandidates.forEach((u: string) => {
      // 5-char prefix from "myhost" (truncated) + 5-hex suffix
      expect(u).toMatch(/^myhos[a-f0-9]{5}$/);
    });
  });

  it("prefix sanitises non-alnum chars + caps at 5 chars; fallback 'user' for empty prefix", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "user12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(
      { ...ITEM, domainName: "...!@#$" } as never,
      CTX as never
    );
    const u = daCreateUser.mock.calls[0][0].usernameCandidates[0];
    expect(u).toMatch(/^user[a-f0-9]{5}$/);
  });

  it("DA call shape: email + domain (linkedDomain wins) + packageName + ip + candidates", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(
      { ...ITEM, linkedDomain: "linked.com" } as never,
      CTX as never
    );
    const [args] = daCreateUser.mock.calls[0];
    expect(args.email).toBe("u@x.test");
    expect(args.domain).toBe("linked.com"); // linkedDomain wins over domainName
    expect(args.packageName).toBe("Standard");
    expect(args.ip).toBe("10.0.0.1");
  });
});

describe("provisionHostingItem — daCreateUser outcome dispatch", () => {
  it("'created' → captures username + setUserDirectAdminUsername + email + Hosting row", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "alice12345" });
    createHosting.mockResolvedValueOnce({});
    const result = await provisionHostingItem(ITEM as never, CTX as never);
    expect(setUserDirectAdminUsername).toHaveBeenCalledWith(
      "USER_ID",
      "alice12345"
    );
    expect(sendHostingProvisionedEmail).toHaveBeenCalled();
    expect(createHosting).toHaveBeenCalled();
    expect(result.registrationResult.status).toBe("success");
    expect(result.orderDomain.status).toBe("registered");
    expect(result.successfulDomain).toBe("myhost.com");
  });

  it("'username_collision_exhausted' → routed to handleHostingProvisionError → status:'failed'", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "username_collision_exhausted" });
    createPendingHosting.mockResolvedValueOnce({});
    const result = await provisionHostingItem(ITEM as never, CTX as never);
    expect(result.registrationResult.status).toBe("failed");
    expect(setUserDirectAdminUsername).not.toHaveBeenCalled();
  });

  it("'da_unreachable' → status:'pending' + 'queued ... temporarily unavailable' user msg + PendingHosting:'pending'", async () => {
    daCreateUser.mockResolvedValueOnce({
      kind: "da_unreachable",
      reason: "ECONNREFUSED",
    });
    createPendingHosting.mockResolvedValueOnce({});
    const result = await provisionHostingItem(ITEM as never, CTX as never);
    expect(result.registrationResult.status).toBe("pending");
    expect(result.registrationResult.error).toMatch(/temporarily unavailable/i);
    expect(result.orderDomain.status).toBe("pending");
    // PendingHosting created with status:'pending' (cron will retry)
    expect(createPendingHosting).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending" })
    );
  });

  it("'hard_failure' → status:'failed' + generic 'team notified' msg + PendingHosting:'failed'", async () => {
    daCreateUser.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "Package 'Standard' does not exist on the server",
    });
    createPendingHosting.mockResolvedValueOnce({});
    const result = await provisionHostingItem(ITEM as never, CTX as never);
    expect(result.registrationResult.status).toBe("failed");
    expect(result.registrationResult.error).toMatch(/team has been notified/i);
    // Internal DA detail MUST NOT leak to the user.
    expect(result.registrationResult.error).not.toMatch(
      /Package .Standard. does not exist/
    );
    expect(createPendingHosting).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });
});

describe("resolveDaPackageName fallback chain (via DA-call args)", () => {
  it("explicit serverPackage wins", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(
      {
        ...ITEM,
        hostingPlan: { serverPackage: "Plus", name: "Premium" },
      } as never,
      CTX as never
    );
    expect(daCreateUser.mock.calls[0][0].packageName).toBe("Plus");
  });

  it("name-based inference: 'starter' / 'standard' / 'plus' in plan name", async () => {
    daCreateUser.mockResolvedValue({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValue({});
    await provisionHostingItem(
      {
        ...ITEM,
        hostingPlan: { name: "Starter Hosting" },
      } as never,
      CTX as never
    );
    expect(daCreateUser.mock.calls[0][0].packageName).toBe("Starter");

    await provisionHostingItem(
      {
        ...ITEM,
        hostingPlan: { name: "Standard Hosting Plus More" },
      } as never,
      CTX as never
    );
    // Both 'standard' and 'plus' match — first wins (Standard).
    expect(daCreateUser.mock.calls[1][0].packageName).toBe("Standard");
  });

  it("price-based fallback via PRICE_TO_PACKAGE lookup", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(
      {
        ...ITEM,
        price: 99,
        hostingPlan: undefined,
      } as never,
      CTX as never
    );
    // price 99 → Starter (from mock HOSTING_PLANS)
    expect(daCreateUser.mock.calls[0][0].packageName).toBe("Starter");
  });

  it("nothing resolves → env DA_DEFAULT_PACKAGE → literal 'Starter'", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(
      {
        ...ITEM,
        price: 9999, // not in PRICE_TO_PACKAGE
        hostingPlan: undefined,
      } as never,
      CTX as never
    );
    expect(daCreateUser.mock.calls[0][0].packageName).toBe("Starter");
  });

  it("env DA_DEFAULT_PACKAGE overrides the 'Starter' literal", async () => {
    vi.stubEnv("DA_DEFAULT_PACKAGE", "CustomPlan");
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(
      {
        ...ITEM,
        price: 9999,
        hostingPlan: undefined,
      } as never,
      CTX as never
    );
    expect(daCreateUser.mock.calls[0][0].packageName).toBe("CustomPlan");
    vi.unstubAllEnvs();
  });
});

describe("provisionHostingItem — trial item invariants", () => {
  it("isTrial:true → ALWAYS 15-day expiry regardless of caller's registrationPeriod", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(
      {
        ...ITEM,
        isTrial: true,
        registrationPeriod: 999, // Should be ignored
        periodUnit: "years", // Should be overridden to 'days'
      } as never,
      CTX as never
    );
    expect(calculateHostingDates).toHaveBeenCalledWith(15, "days");
  });

  it("isTrial:true result.message mentions '15 days free'", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    const result = await provisionHostingItem(
      { ...ITEM, isTrial: true } as never,
      CTX as never
    );
    expect(result.registrationResult.message).toMatch(/15 days free/i);
  });

  it("isTrial:false (default) → uses caller's registrationPeriod + periodUnit", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(
      { ...ITEM, registrationPeriod: 6, periodUnit: "months" } as never,
      CTX as never
    );
    expect(calculateHostingDates).toHaveBeenCalledWith(6, "months");
  });

  it("periodUnit 'years' is rewritten to 'months' (hosting plans store monthly cycles)", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(
      { ...ITEM, periodUnit: "years", registrationPeriod: 1 } as never,
      CTX as never
    );
    expect(calculateHostingDates).toHaveBeenCalledWith(1, "months");
  });

  it("periodUnit undefined → defaults to 'months'", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(
      { ...ITEM, periodUnit: undefined } as never,
      CTX as never
    );
    expect(calculateHostingDates).toHaveBeenCalledWith(12, "months");
  });

  it("periodUnit 'days' / 'minutes' pass through unchanged", async () => {
    daCreateUser.mockResolvedValue({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValue({});
    await provisionHostingItem(
      { ...ITEM, periodUnit: "days", registrationPeriod: 3 } as never,
      CTX as never
    );
    expect(calculateHostingDates).toHaveBeenCalledWith(3, "days");

    await provisionHostingItem(
      { ...ITEM, periodUnit: "minutes", registrationPeriod: 10 } as never,
      CTX as never
    );
    expect(calculateHostingDates).toHaveBeenLastCalledWith(10, "minutes");
  });
});

describe("provisionHostingItem — Hosting record creation", () => {
  it("next_action_at = expiresAt - FIRST_REMINDER_DAYS×24h (30 days)", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(ITEM as never, CTX as never);
    const [payload] = createHosting.mock.calls[0];
    expect(payload.next_action_at.getTime()).toBe(
      EXPIRES_AT.getTime() - 30 * 24 * 60 * 60 * 1000
    );
  });

  it("autoRenew + billingType keyed on razorpay_subscription_id presence", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(ITEM as never, {
      ...CTX,
      razorpay_subscription_id: "sub_xyz",
    } as never);
    const [payload] = createHosting.mock.calls[0];
    expect(payload.autoRenew).toBe(true);
    expect(payload.billingType).toBe("subscription");
    expect(payload.subscriptionId).toBe("sub_xyz");
  });

  it("no subscription → autoRenew:false + billingType:'manual'", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(ITEM as never, CTX as never);
    const [payload] = createHosting.mock.calls[0];
    expect(payload.autoRenew).toBe(false);
    expect(payload.billingType).toBe("manual");
    expect(payload.subscriptionId).toBeUndefined();
  });

  it("createHosting failure SWALLOWED — provisioning still reports success (DA is source of truth)", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    createHosting.mockRejectedValueOnce(new Error("dup key"));
    const result = await provisionHostingItem(ITEM as never, CTX as never);
    expect(result.registrationResult.status).toBe("success");
  });
});

describe("provisionHostingItem — side-effects + email", () => {
  it("setUserDirectAdminUsername called with stringified user._id + the DA username", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "alice12345" });
    createHosting.mockResolvedValueOnce({});
    await provisionHostingItem(ITEM as never, CTX as never);
    expect(setUserDirectAdminUsername).toHaveBeenCalledWith(
      "USER_ID",
      "alice12345"
    );
  });

  it("getPlanByPlanId enrichment failure → falls back to packageName as planName (still proceeds)", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    getPlanByPlanId.mockRejectedValueOnce(new Error("plan lookup down"));
    createHosting.mockResolvedValueOnce({});
    const result = await provisionHostingItem(ITEM as never, CTX as never);
    expect(result.registrationResult.status).toBe("success");
  });

  it("sendHostingProvisionedEmail failure SWALLOWED — provisioning still reports success", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "abc12345" });
    sendHostingProvisionedEmail.mockRejectedValueOnce(new Error("SMTP down"));
    createHosting.mockResolvedValueOnce({});
    const result = await provisionHostingItem(ITEM as never, CTX as never);
    expect(result.registrationResult.status).toBe("success");
  });
});

describe("handleHostingProvisionError — DA-unreachable vs hard-failure routing", () => {
  it("DA-unreachable bookingStep = 'hosting_deferred' + progress:50", async () => {
    daCreateUser.mockResolvedValueOnce({
      kind: "da_unreachable",
      reason: "ECONNREFUSED 10.0.0.1:2222",
    });
    createPendingHosting.mockResolvedValueOnce({});
    const result = await provisionHostingItem(ITEM as never, CTX as never);
    const step = (
      result.orderDomain.bookingStatus as Array<{ step: string; progress: number }>
    )[0];
    expect(step.step).toBe("hosting_deferred");
    expect(step.progress).toBe(50);
  });

  it("hard-failure bookingStep = 'domain_failed' + progress:100", async () => {
    daCreateUser.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "Invalid package",
    });
    createPendingHosting.mockResolvedValueOnce({});
    const result = await provisionHostingItem(ITEM as never, CTX as never);
    const step = (
      result.orderDomain.bookingStatus as Array<{ step: string; progress: number }>
    )[0];
    expect(step.step).toBe("domain_failed");
    expect(step.progress).toBe(100);
  });

  it("createPendingHosting failure SWALLOWED — orderDomain.error still surfaces the raw DA reason for admin postmortem", async () => {
    daCreateUser.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "DETAILED INTERNAL REASON",
    });
    createPendingHosting.mockRejectedValueOnce(new Error("phs db down"));
    const result = await provisionHostingItem(ITEM as never, CTX as never);
    expect(result.registrationResult.status).toBe("failed");
    // 2026-06-22: orderDomain.error now carries the raw DA reason (was the
    // generic user-facing copy until today). The user-facing string still
    // shows in `result.registrationResult.error` and in
    // `orderDomain.bookingStatus[last].message`; orderDomain.error is
    // free to be diagnostic-quality because the customer order page
    // reads bookingStatus, not orderDomain.error.
    expect(result.orderDomain.error).toContain("DETAILED INTERNAL REASON");
    expect(result.registrationResult.error).toMatch(/team has been notified/i);
  });

  it("PendingHosting payload includes raw error.message for postmortem (NOT the user-facing version)", async () => {
    daCreateUser.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "DETAILED INTERNAL REASON",
    });
    createPendingHosting.mockResolvedValueOnce({});
    await provisionHostingItem(ITEM as never, CTX as never);
    const [payload] = createPendingHosting.mock.calls[0];
    expect(payload.error).toContain("DETAILED INTERNAL REASON");
  });
});
