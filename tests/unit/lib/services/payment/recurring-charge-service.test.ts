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
const RCAFindOneAndUpdate = vi.hoisted(() => {
  const chain = { exec: () => Promise.resolve(null) };
  return vi.fn(() => chain);
});
// countDocuments({hostingId, status: 'succeeded'}) — used to discriminate
// "first post-trial charge" (returns 0 → strict 1-attempt rule) from
// "subsequent renewal" (returns >= 1 → 4-attempt rule with backoff).
const RCACountDocuments = vi.hoisted(() => vi.fn());
vi.mock("@/models/RecurringChargeAttempt", () => ({
  default: {
    create: RCACreate,
    findOne: RCAFindOne,
    findOneAndUpdate: RCAFindOneAndUpdate,
    countDocuments: RCACountDocuments,
  },
  __esModule: true,
}));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const chargeViaToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({ RazorpayService: { chargeViaToken } }));

const daSuspendUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({ suspendUser: daSuspendUser }));

const sendServiceSuspensionEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendServiceSuspensionEmail },
}));

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
  RCAFindOneAndUpdate.mockReset().mockReturnValue({ exec: () => Promise.resolve(null) });
  // Default: pretend this hosting HAS had a prior successful charge so the
  // renewal-retry (4-attempt) policy applies. Tests that want to exercise
  // the strict first-charge (1-attempt) rule override with mockResolvedValueOnce(0).
  RCACountDocuments.mockReset().mockResolvedValue(1);
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
  daSuspendUser.mockReset().mockResolvedValue({ kind: "suspended" });
  sendServiceSuspensionEmail.mockReset().mockResolvedValue(true);
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
  it("claims attempt, charges via token, extends expiry by 1 year (yearly inferred), marks succeeded — Hosting saved BEFORE attempt (Bug 2 fix)", async () => {
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

    // Track save ORDER — Hosting must save BEFORE attempt to avoid the
    // money-loss-on-Hosting-save-failure bug (Bug 2 from the audit).
    const saveOrder: string[] = [];
    hosting.save.mockImplementationOnce(async () => {
      saveOrder.push("hosting");
    });
    claimedAttempt.save.mockImplementationOnce(async () => {
      saveOrder.push("attempt");
    });

    const result = await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(result.outcome).toBe("succeeded");
    expect(result.attemptCount).toBe(1);

    // Bug 2 fix: Hosting (expiry extension) saved BEFORE attempt (success mark)
    expect(saveOrder).toEqual(["hosting", "attempt"]);

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

  it("Bug 2 fix: hosting.save failure throws BEFORE marking attempt 'succeeded' (no charged-but-service-not-extended state)", async () => {
    const hosting = makeHosting();
    const claimedAttempt = {
      attemptCount: 1,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(claimedAttempt);
    chargeViaToken.mockResolvedValueOnce({
      orderId: "order_x",
      paymentId: "pay_x",
      amount: 59988,
    });
    hosting.save.mockRejectedValueOnce(new Error("Mongo write conflict"));

    // chargeRecurringHosting throws because hosting.save throws
    await expect(
      chargeRecurringHosting(
        hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
      )
    ).rejects.toThrow(/Mongo write conflict/);

    // Attempt was NOT marked 'succeeded' (the bug-2 scenario: if attempt
    // were marked 'succeeded' first, the next cron run would skip via
    // idempotency, leaving the customer charged-but-not-served forever).
    // With the fix, the attempt stays 'in_progress' so the operator can
    // unstick it manually, or a future enhancement can timeout-recover.
    expect(claimedAttempt.status).toBe("in_progress");
    expect(claimedAttempt.save).not.toHaveBeenCalled();
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

  it("existing attempt 'failed' with nextAttemptAt in past → atomic findOneAndUpdate claims the retry (attempt count bumped)", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const initialAttempt = {
      _id: "attempt_R",
      attemptCount: 1,
      status: "failed",
      nextAttemptAt: past,
    };
    const claimedAttempt = {
      _id: "attempt_R",
      attemptCount: 2,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockRejectedValueOnce({ code: 11000 });
    RCAFindOne.mockReturnValueOnce({ exec: () => Promise.resolve(initialAttempt) } as never);
    // findOneAndUpdate (the atomic claim) returns the updated doc
    RCAFindOneAndUpdate.mockReturnValueOnce({
      exec: () => Promise.resolve(claimedAttempt),
    } as never);
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

    // The atomic claim was guarded on status='failed' (so a concurrent cron
    // that already flipped status couldn't race us into double-charging)
    expect(RCAFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "attempt_R", status: "failed" }),
      expect.objectContaining({
        $inc: { attemptCount: 1 },
        $set: expect.objectContaining({ status: "in_progress" }),
      }),
      expect.anything()
    );
    expect(chargeViaToken).toHaveBeenCalled();
  });

  it("retry claim race: another cron won the claim (findOneAndUpdate returns null) → skip without charging", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const initialAttempt = {
      _id: "attempt_R",
      attemptCount: 1,
      status: "failed",
      nextAttemptAt: past,
    };
    RCACreate.mockRejectedValueOnce({ code: 11000 });
    RCAFindOne.mockReturnValueOnce({ exec: () => Promise.resolve(initialAttempt) } as never);
    // findOneAndUpdate returns null — another cron raced ahead and flipped
    // the status between our read above and our atomic update
    RCAFindOneAndUpdate.mockReturnValueOnce({
      exec: () => Promise.resolve(null),
    } as never);

    const result = await chargeRecurringHosting(
      makeHosting() as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toMatch(/retry claim race lost/);
    expect(chargeViaToken).not.toHaveBeenCalled();
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
  it("RENEWAL first failure → 'abandoned' on attempt 1 (hard rule extended to renewals)", async () => {
    // Renewal scenario (priorSuccessCount=1 via the default beforeEach
    // mock). Under the unified hard 1-attempt policy, even renewals
    // abandon immediately on first failure — no soft-grace, no retry
    // scheduling. lastError is still captured for audit.
    const attempt = {
      attemptCount: 1,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    chargeViaToken.mockRejectedValueOnce(new Error("Razorpay card declined"));

    const result = await chargeRecurringHosting(
      makeHosting() as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(result.outcome).toBe("abandoned");
    const attemptObj = attempt as unknown as { status: string; lastError?: string; nextAttemptAt?: Date };
    expect(attemptObj.status).toBe("abandoned");
    expect(attemptObj.lastError).toBe("Razorpay card declined");
    // No retry scheduling under the unified policy
    expect(attemptObj.nextAttemptAt).toBeUndefined();
  });

  it("renewal failure with attemptCount=4 (legacy soft-grace row from pre-unified-policy) → 'abandoned' + DA suspended + Hosting expired + suspension email sent (Phase 2F — kept for backward compat with rows created under the old 4-attempt policy)", async () => {
    const hosting = makeHosting({ directAdminUsername: "userxxx" });
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

    // Hosting expiry NOT changed (no successful charge → no extension)
    expect((hosting as { expiryDate: Date }).expiryDate.getTime()).toBe(originalExpiry);

    // Phase 2F: DA suspended with attempt count in the reason
    expect(daSuspendUser).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "userxxx",
        reason: expect.stringMatching(/Renewal charge failed on first attempt/i),
      })
    );

    // Phase 2F: Hosting flipped to 'expired' + saved
    expect((hosting as unknown as { status: string }).status).toBe("expired");
    expect(hosting.save).toHaveBeenCalled();

    // Phase 2F: suspension email sent
    expect(sendServiceSuspensionEmail).toHaveBeenCalledWith(
      "user@x.com",
      expect.objectContaining({
        serviceName: "example.com",
        serviceType: "Hosting",
        // Hard 1-attempt rule means every abandonment path on the Tokens
        // service is mandateMode='tokens' — the suspension-email template
        // renders the re-subscribe recovery block.
        mandateMode: "tokens",
      })
    );
  });

  it("FIRST POST-TRIAL CHARGE failure → abandoned on attempt 1 (hard rule, no retries) + DA suspended + Hosting expired + suspension email sent", async () => {
    // Trial-conversion failure scenario: zero prior succeeded attempts for
    // this hosting means the customer is on the FIRST post-trial charge.
    // Hard rule: 1 attempt then suspend.
    RCACountDocuments.mockResolvedValueOnce(0); // <-- no prior succeeded charges
    const hosting = makeHosting({ directAdminUsername: "userxxx" });
    const originalExpiry = new Date(hosting.expiryDate).getTime();
    const attempt = {
      attemptCount: 1, // <-- first attempt, not the 4th
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    chargeViaToken.mockRejectedValueOnce(new Error("Card declined"));

    const result = await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(result.outcome).toBe("abandoned");
    expect(result.attemptCount).toBe(1); // <-- key assertion: abandoned on attempt 1
    const attemptObj = attempt as unknown as { status: string; abandonedAt?: Date; nextAttemptAt?: Date };
    expect(attemptObj.status).toBe("abandoned");
    expect(attemptObj.abandonedAt).toBeInstanceOf(Date);
    // No retry should be scheduled for first-charge fail
    expect(attemptObj.nextAttemptAt).toBeUndefined();

    // Hosting expiry NOT changed
    expect((hosting as { expiryDate: Date }).expiryDate.getTime()).toBe(originalExpiry);

    // DA suspended with first-charge-specific reason string
    expect(daSuspendUser).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "userxxx",
        reason: expect.stringMatching(/Trial.*paid conversion failed on first charge/i),
      })
    );

    // Hosting flipped to 'expired' + suspension email sent
    expect((hosting as unknown as { status: string }).status).toBe("expired");
    expect(sendServiceSuspensionEmail).toHaveBeenCalled();
  });

  it("FIRST POST-TRIAL CHARGE does NOT schedule retry — straight to abandon (regression guard)", async () => {
    RCACountDocuments.mockResolvedValueOnce(0);
    const hosting = makeHosting();
    const attempt = {
      attemptCount: 1,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    chargeViaToken.mockRejectedValueOnce(new Error("Insufficient balance"));

    const result = await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    // Regression guard: nothing about this should look like a "retry"
    expect(result.outcome).not.toBe("retry_scheduled");
    expect(result.outcome).toBe("abandoned");
  });

  it("RENEWAL (priorSuccessCount >= 1) failure on attempt 1 → 'abandoned' on first attempt (unified hard rule extended to renewals)", async () => {
    // Long-term paying customer (3 prior succeeded yearly renewals) has
    // their renewal charge fail. Under the unified hard 1-attempt policy
    // shipped after 5ea21a6, even renewals abandon immediately — no
    // soft-grace window. The trial-vs-renewal differentiation is kept
    // only for log + DA-suspend-reason audit trail; technical policy is
    // identical for both branches.
    RCACountDocuments.mockResolvedValueOnce(3); // 3 prior succeeded yearly renewals
    const hosting = makeHosting({ directAdminUsername: "userxxx" });
    const attempt = {
      attemptCount: 1,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    chargeViaToken.mockRejectedValueOnce(new Error("Card declined"));

    const result = await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(result.outcome).toBe("abandoned");
    expect(result.attemptCount).toBe(1);
    const attemptObj = attempt as unknown as { status: string; nextAttemptAt?: Date; abandonedAt?: Date };
    expect(attemptObj.status).toBe("abandoned");
    expect(attemptObj.abandonedAt).toBeInstanceOf(Date);
    expect(attemptObj.nextAttemptAt).toBeUndefined();

    // DA suspended with the renewal-specific reason (not the trial-conversion reason)
    expect(daSuspendUser).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "userxxx",
        reason: expect.stringMatching(/Renewal charge failed on first attempt/i),
      })
    );

    // Hosting flipped to 'expired' + suspension email sent
    expect((hosting as unknown as { status: string }).status).toBe("expired");
    expect(sendServiceSuspensionEmail).toHaveBeenCalled();
  });

  it("Phase 2F: abandonment skips DA suspend when directAdminUsername is empty (defensive)", async () => {
    const hosting = makeHosting({ directAdminUsername: "" });
    const attempt = {
      attemptCount: 4,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    chargeViaToken.mockRejectedValueOnce(new Error("Card declined"));

    await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(daSuspendUser).not.toHaveBeenCalled();
    // Hosting still gets flipped to 'expired' + email still sent
    expect((hosting as unknown as { status: string }).status).toBe("expired");
    expect(sendServiceSuspensionEmail).toHaveBeenCalled();
  });

  it("Phase 2F: DA suspend failure does NOT block Hosting.status='expired' + email send", async () => {
    daSuspendUser.mockRejectedValueOnce(new Error("DA unreachable"));
    const hosting = makeHosting({ directAdminUsername: "userxxx" });
    const attempt = {
      attemptCount: 4,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    chargeViaToken.mockRejectedValueOnce(new Error("Card declined"));

    const result = await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(result.outcome).toBe("abandoned");
    expect((hosting as unknown as { status: string }).status).toBe("expired");
    expect(sendServiceSuspensionEmail).toHaveBeenCalled();
  });

  it("Phase 2F: suspension email failure does NOT block DA suspend + Hosting.status flip", async () => {
    sendServiceSuspensionEmail.mockRejectedValueOnce(new Error("SMTP down"));
    const hosting = makeHosting({ directAdminUsername: "userxxx" });
    const attempt = {
      attemptCount: 4,
      status: "in_progress",
      save: vi.fn().mockResolvedValue(undefined),
    };
    RCACreate.mockResolvedValueOnce(attempt);
    chargeViaToken.mockRejectedValueOnce(new Error("Card declined"));

    const result = await chargeRecurringHosting(
      hosting as unknown as Parameters<typeof chargeRecurringHosting>[0]
    );

    expect(result.outcome).toBe("abandoned");
    expect(daSuspendUser).toHaveBeenCalled();
    expect((hosting as unknown as { status: string }).status).toBe("expired");
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
