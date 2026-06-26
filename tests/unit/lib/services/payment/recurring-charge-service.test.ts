/**
 * Tests for `lib/services/payment/recurring-charge-service.ts` (Phase 2D).
 *
 * The Tokens-flow merchant-initiated transaction (MIT) charging logic.
 * Coverage:
 *  - findHostingsDueForCharge: returns Hostings with razorpayTokenId set
 *    AND expiryDate within the lookahead window
 *  - chargeRecurringHosting:
 *    - happy path: claims attempt, calls chargeViaToken, extends expiry
 *      on success, marks attempt 'succeeded'
 *    - dry-run: doesn't call Razorpay; resets attempt to 'pending'
 *    - hosting missing razorpayTokenId → 'skipped' early
 *    - plan not found → 'skipped'
 *    - dedup race (existing attempt 'succeeded'): 'skipped'
 *    - retry-eligible (existing attempt 'failed', nextAttemptAt past):
 *      bumps attemptCount, retries
 *    - failure schedules retry with T+1d backoff
 *    - failure after MAX_ATTEMPTS → 'abandoned' (no expiry extension)
 *    - yearly inference: hosting that started 11+ months before expiry
 *      is treated as yearly (renews +1yr); shorter cycles → monthly
 *
 * All DB models + RazorpayService mocked at module boundary. No
 * MongoDB / no Razorpay network calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findHostingDocs = vi.hoisted(() => vi.fn());
const HostingFind = vi.hoisted(() => {
  // chainable: .sort().limit().exec()
  const chain = {
    sort: () => chain,
    limit: () => chain,
    exec: () => findHostingDocs(),
  };
  return vi.fn(() => chain);
});
vi.mock("@/models/Hosting", () => ({
  default: { find: HostingFind },
  __esModule: true,
}));

const RCACreate = vi.hoisted(() => vi.fn());
const RCAFindOne = vi.hoisted(() => {
  const chain = { exec: () => Promise.resolve(null) };
  return vi.fn(() => chain);
});
vi.mock("@/models/RecurringChargeAttempt", () => ({
  default: {
    create: RCACreate,
    findOne: RCAFindOne,
  },
  __esModule: true,
}));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const chargeViaToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({ RazorpayService: { chargeViaToken } }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  findHostingsDueForCharge,
  chargeRecurringHosting,
} from "@/lib/services/payment/recurring-charge-service";

function makeHosting(over: Record<string, unknown> = {}) {
  const startDate = new Date("2026-06-01");
  const expiryDate = new Date("2027-06-01"); // 12 months → yearly inferred
  return {
    _id: "host_X",
    userId: "U1",
    domainName: "example.com",
    planId: "starter",
    razorpayCustomerId: "cust_X",
    razorpayTokenId: "token_X",
    startDate,
    expiryDate,
    last_reminder_sent: null,
    save: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  HostingFind.mockClear();
  findHostingDocs.mockReset().mockResolvedValue([]);
  RCACreate.mockReset();
  RCAFindOne.mockReset().mockReturnValue({ exec: () => Promise.resolve(null) });
  getPlanByPlanId.mockReset().mockResolvedValue({
    planId: "starter",
    name: "Starter",
    renewalPrice: 49.99,
  });
  getUserById.mockReset().mockResolvedValue({
    _id: "U1",
    email: "user@x.com",
    phone: "9876543210",
  });
  chargeViaToken.mockReset();
});

describe("findHostingsDueForCharge", () => {
  it("queries with status=active + razorpayTokenId present + expiryDate <= now + 1 day", async () => {
    findHostingDocs.mockResolvedValueOnce([makeHosting()]);
    const fixed = new Date("2026-06-26T00:00:00Z");
    await findHostingsDueForCharge({ now: fixed });

    const filter = (HostingFind.mock.calls as unknown as [[{
      status?: string;
      razorpayTokenId?: { $exists?: boolean };
      expiryDate?: { $lte: Date };
    }]])[0][0];
    expect(filter.status).toBe("active");
    expect(filter.razorpayTokenId).toMatchObject({ $exists: true });
    const cutoff = filter.expiryDate!.$lte;
    // cutoff = fixed + 1 day
    expect(cutoff.toISOString()).toBe("2026-06-27T00:00:00.000Z");
  });
});

describe("chargeRecurringHosting — happy path", () => {
  it("claims attempt, charges via token, extends expiry by 1 year (yearly inferred), marks succeeded", async () => {
    const hosting = makeHosting();
    const claimedAttempt = {
      attemptCount: 1,
      status: "in_progress",
      lastAttemptAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(claimedAttempt);
    chargeViaToken.mockResolvedValueOnce({
      orderId: "order_MIT_X",
      paymentId: "pay_MIT_X",
      amount: 59988,
    });

    const result = await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(result.outcome).toBe("succeeded");
    expect(result.attemptCount).toBe(1);

    // Charge fired with yearly amount = renewalPrice × 12
    expect(chargeViaToken).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cust_X",
        tokenId: "token_X",
        amountInRupees: 49.99 * 12,
      })
    );

    // Attempt persisted as 'succeeded' with payment id
    expect(claimedAttempt.status).toBe("succeeded");
    const attemptObj = claimedAttempt as unknown as { razorpayPaymentId?: string };
    expect(attemptObj.razorpayPaymentId).toBe("pay_MIT_X");

    // Hosting expiry extended by 1 year
    const newExpiry = (hosting as { expiryDate: Date }).expiryDate;
    expect(newExpiry.getFullYear()).toBe(2028); // was 2027 → +1
    expect(hosting.save).toHaveBeenCalled();
  });
});

describe("chargeRecurringHosting — early-exit cases", () => {
  it("missing razorpayTokenId → 'skipped' without claiming attempt", async () => {
    const hosting = makeHosting({ razorpayTokenId: undefined });
    const result = await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );
    expect(result.outcome).toBe("skipped");
    expect(RCACreate).not.toHaveBeenCalled();
    expect(chargeViaToken).not.toHaveBeenCalled();
  });

  it("plan not found → 'skipped'", async () => {
    getPlanByPlanId.mockResolvedValueOnce(null);
    const result = await chargeRecurringHosting(
      makeHosting() as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toMatch(/plan not found/);
    expect(RCACreate).not.toHaveBeenCalled();
  });

  it("dry-run: doesn't call Razorpay; resets in-progress attempt back to pending", async () => {
    const attempt = {
      attemptCount: 1,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    const result = await chargeRecurringHosting(
      makeHosting() as unknown as Parameters<typeof chargeRecurringHosting>[0],
      { dryRun: true }
    );
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("dry-run");
    expect(chargeViaToken).not.toHaveBeenCalled();
    expect(attempt.status).toBe("pending");
  });
});

describe("chargeRecurringHosting — dedup + retry races", () => {
  it("existing attempt already 'succeeded' (E11000) → 'skipped'", async () => {
    RCACreate.mockRejectedValueOnce({ code: 11000 });
    RCAFindOne.mockReturnValueOnce({
      exec: () =>
        Promise.resolve({
          attemptCount: 1,
          status: "succeeded",
        }),
    } as never);

    const result = await chargeRecurringHosting(
      makeHosting() as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("already succeeded");
    expect(chargeViaToken).not.toHaveBeenCalled();
  });

  it("existing attempt 'failed' with nextAttemptAt in past → retries (attempt count bumped)", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const attempt = {
      attemptCount: 1,
      status: "failed",
      nextAttemptAt: past,
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockRejectedValueOnce({ code: 11000 });
    RCAFindOne.mockReturnValueOnce({ exec: () => Promise.resolve(attempt) } as never);
    chargeViaToken.mockResolvedValueOnce({
      orderId: "order_MIT_R",
      paymentId: "pay_MIT_R",
      amount: 59988,
    });

    const result = await chargeRecurringHosting(
      makeHosting() as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );
    expect(result.outcome).toBe("succeeded");
    expect(result.attemptCount).toBe(2);
    expect(chargeViaToken).toHaveBeenCalled();
  });

  it("existing attempt 'failed' with nextAttemptAt FUTURE → 'skipped' (wait for scheduled retry)", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    RCACreate.mockRejectedValueOnce({ code: 11000 });
    RCAFindOne.mockReturnValueOnce({
      exec: () =>
        Promise.resolve({
          attemptCount: 2,
          status: "failed",
          nextAttemptAt: future,
        }),
    } as never);

    const result = await chargeRecurringHosting(
      makeHosting() as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );
    expect(result.outcome).toBe("skipped");
    expect(chargeViaToken).not.toHaveBeenCalled();
  });
});

describe("chargeRecurringHosting — failure handling", () => {
  it("first failure → 'retry_scheduled' with nextAttemptAt +1 day", async () => {
    const attempt = {
      attemptCount: 1,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    chargeViaToken.mockRejectedValueOnce(new Error("Razorpay card declined"));

    const before = Date.now();
    const result = await chargeRecurringHosting(
      makeHosting() as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(result.outcome).toBe("retry_scheduled");
    const attemptObj = attempt as unknown as { status: string; lastError?: string; nextAttemptAt?: Date };
    expect(attemptObj.status).toBe("failed");
    expect(attemptObj.lastError).toBe("Razorpay card declined");
    expect(attemptObj.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 0.9 * 24 * 60 * 60 * 1000);
    expect(attemptObj.nextAttemptAt!.getTime()).toBeLessThanOrEqual(before + 1.1 * 24 * 60 * 60 * 1000);
  });

  it("4th failure (MAX_ATTEMPTS = initial + 3 retries) → 'abandoned'; expiry NOT extended", async () => {
    const hosting = makeHosting();
    const originalExpiry = new Date(hosting.expiryDate).getTime();
    const attempt = {
      attemptCount: 4,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    chargeViaToken.mockRejectedValueOnce(new Error("Mandate revoked by customer"));

    const result = await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(result.outcome).toBe("abandoned");
    const attemptObj = attempt as unknown as { status: string; abandonedAt?: Date };
    expect(attemptObj.status).toBe("abandoned");
    expect(attemptObj.abandonedAt).toBeInstanceOf(Date);

    // Hosting expiry NOT changed
    expect((hosting as { expiryDate: Date }).expiryDate.getTime()).toBe(originalExpiry);
    expect(hosting.save).not.toHaveBeenCalled();
  });
});

describe("chargeRecurringHosting — yearly vs monthly inference", () => {
  it("hosting cycle ~1 month → monthly inferred → amountInRupees = renewalPrice (not ×12)", async () => {
    const startDate = new Date("2026-06-01");
    const expiryDate = new Date("2026-07-01"); // ~1 month
    const hosting = makeHosting({ startDate, expiryDate });

    const attempt = {
      attemptCount: 1,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    chargeViaToken.mockResolvedValueOnce({
      orderId: "o",
      paymentId: "p",
      amount: 4999,
    });

    await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(chargeViaToken.mock.calls[0][0].amountInRupees).toBe(49.99);
  });
});
