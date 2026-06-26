/**
 * Tokens-flow recurring-charge service (Phase 2D).
 *
 * The merchant-side counterpart to Razorpay's Subscriptions API — since we
 * use the Tokens API instead, WE are responsible for scheduling + firing
 * recurring debits. This module is the business logic. The cron wrapper
 * lives at `scripts/charge-recurring-hostings.js`.
 *
 * Architecture (matches docs/razorpay-tokens-migration.md §3.4 + §3.5):
 *  1. Cron calls `findHostingsDueForCharge()` to get hostings whose
 *     expiryDate is <= today + 1 day (charge 1 day before expiry).
 *  2. For each, calls `chargeRecurringHosting()`:
 *     - Looks up the user + plan (for the charge amount)
 *     - Atomically claims (status='in_progress') a RecurringChargeAttempt
 *       row keyed by (hostingId, dueDate) — unique-index dedup means a
 *       second cron run on the same billing cycle is a no-op
 *     - Calls RazorpayService.chargeViaToken
 *     - On success: extends Hosting.expiryDate by one billing period;
 *       flips RecurringChargeAttempt to 'succeeded'
 *     - On failure: schedules nextAttemptAt per the retry policy
 *       (T+1, T+3, T+7 days); after 4 failed attempts marks 'abandoned'
 *
 * NOT in scope here (Phase 2E+):
 *  - DA suspend on abandoned attempts
 *  - Dunning email after abandoned
 *  - The actual Cloud Scheduler cron job creation
 *  - Frontend Checkout opener mandateMode switch
 *  - First-charge case for trial Hostings (status='pending') — those
 *    need DA provisioned first, which is its own cron
 */
import type { HydratedDocument } from "mongoose";
import Hosting, { type IHosting } from "@/models/Hosting";
import RecurringChargeAttempt from "@/models/RecurringChargeAttempt";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { getUserById } from "@/lib/services/users";
import { RazorpayService } from "@/lib/razorpay";
import { suspendUser as daSuspendUser } from "@/lib/integrations/directadmin";
import { EmailService } from "@/lib/email";
import { serverLogger } from "@/lib/server-logger";

/**
 * Look-ahead window for the charge: if a Hosting's expiry is within this
 * many days, the cron picks it up. 1 day = "charge tomorrow's expirations".
 */
const CHARGE_LOOKAHEAD_DAYS = 1;

/** Retry policy: backoff after each failed attempt, in days. */
const RETRY_BACKOFF_DAYS = [1, 3, 7] as const;
const MAX_ATTEMPTS = RETRY_BACKOFF_DAYS.length + 1; // initial + N retries

export interface ChargeResult {
  hostingId: string;
  domainName: string;
  outcome: "succeeded" | "retry_scheduled" | "abandoned" | "skipped";
  attemptCount: number;
  reason?: string;
  newExpiryDate?: Date;
}

/**
 * Find hostings whose expiry falls within the lookahead window AND have
 * a stored mandate token (= Tokens-flow customers). Pure read-only query.
 * Caller iterates and invokes `chargeRecurringHosting()` per result.
 */
export async function findHostingsDueForCharge(opts: {
  now?: Date;
  limit?: number;
} = {}): Promise<HydratedDocument<IHosting>[]> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + CHARGE_LOOKAHEAD_DAYS);

  return Hosting.find({
    status: "active",
    razorpayTokenId: { $exists: true, $ne: null, $nin: ["", null] },
    expiryDate: { $lte: cutoff },
  })
    .sort({ expiryDate: 1 })
    .limit(opts.limit ?? 100)
    .exec();
}

/**
 * Charge one hosting. Idempotent via the unique index on
 * `(hostingId, dueDate)` on RecurringChargeAttempt — a concurrent or
 * retry cron pass on the same row returns 'skipped' without re-charging.
 */
export async function chargeRecurringHosting(
  hosting: HydratedDocument<IHosting>,
  opts: { now?: Date; dryRun?: boolean } = {}
): Promise<ChargeResult> {
  const now = opts.now ?? new Date();
  const dueDate = new Date(hosting.expiryDate); // billing cycle anchor
  const hostingId = String(hosting._id);
  const baseResult: Pick<ChargeResult, "hostingId" | "domainName"> = {
    hostingId,
    domainName: hosting.domainName,
  };

  if (!hosting.razorpayTokenId || !hosting.razorpayCustomerId) {
    return { ...baseResult, outcome: "skipped", attemptCount: 0, reason: "no mandate token / customer id on Hosting" };
  }

  // 1. Look up the plan to determine the charge amount. Yearly hostings
  //    are charged renewalPrice * 12; monthly are charged renewalPrice.
  //    The Hosting itself doesn't store the billing period directly, so
  //    we infer from the original Hosting period length (>= 6 months → yearly).
  const plan = await getPlanByPlanId(hosting.planId);
  if (!plan) {
    return { ...baseResult, outcome: "skipped", attemptCount: 0, reason: `plan not found: ${hosting.planId}` };
  }
  const monthsSinceStart = monthsBetween(hosting.startDate, hosting.expiryDate);
  const isYearly = monthsSinceStart >= 11; // trial 15-day → renews as yearly; existing yearly cycles continue yearly
  const amountInRupees = isYearly ? plan.renewalPrice * 12 : plan.renewalPrice;

  // 2. Atomic claim — try to insert a RecurringChargeAttempt for this
  //    (hostingId, dueDate). Unique-index dedup means the second concurrent
  //    insert hits E11000 and we then read whatever's there.
  let attempt;
  try {
    attempt = await RecurringChargeAttempt.create({
      hostingId: hosting._id,
      userId: hosting.userId,
      customerId: hosting.razorpayCustomerId,
      tokenId: hosting.razorpayTokenId,
      amountInRupees,
      dueDate,
      attemptCount: 1,
      status: "in_progress",
      lastAttemptAt: now,
    });
  } catch (insertErr: unknown) {
    const code = (insertErr as { code?: number }).code;
    if (code !== 11000) {
      throw insertErr; // unexpected DB error → propagate
    }
    // Existing attempt for this billing cycle. Read it; if status is
    // 'succeeded' or 'abandoned', skip. If 'failed' and nextAttemptAt
    // is due, claim it for retry. If 'in_progress' or 'pending', skip
    // (another cron pass owns it).
    attempt = await RecurringChargeAttempt.findOne({
      hostingId: hosting._id,
      dueDate,
    }).exec();
    if (!attempt) {
      // Race we lost AND can't find — odd; bail safely
      return { ...baseResult, outcome: "skipped", attemptCount: 0, reason: "claim race lost; row not readable" };
    }
    if (attempt.status === "succeeded") {
      return { ...baseResult, outcome: "skipped", attemptCount: attempt.attemptCount, reason: "already succeeded" };
    }
    if (attempt.status === "abandoned") {
      return { ...baseResult, outcome: "skipped", attemptCount: attempt.attemptCount, reason: "already abandoned" };
    }
    if (attempt.status === "in_progress") {
      return { ...baseResult, outcome: "skipped", attemptCount: attempt.attemptCount, reason: "another worker in progress" };
    }
    if (attempt.status === "failed") {
      if (attempt.nextAttemptAt && attempt.nextAttemptAt > now) {
        return {
          ...baseResult,
          outcome: "skipped",
          attemptCount: attempt.attemptCount,
          reason: `next retry scheduled for ${attempt.nextAttemptAt.toISOString()}`,
        };
      }
      // Due for retry — bump attemptCount + claim
      attempt.attemptCount += 1;
      attempt.status = "in_progress";
      attempt.lastAttemptAt = now;
      await attempt.save();
    }
  }

  // 3. Call Razorpay (or skip in dry-run)
  if (opts.dryRun) {
    serverLogger.info(
      `[RECURRING-CHARGE] DRY-RUN: would charge ${hosting.domainName} (₹${amountInRupees}, ${isYearly ? "yearly" : "monthly"})`
    );
    // Roll back the in-progress attempt to pending so a real run isn't blocked
    attempt.status = "pending";
    await attempt.save();
    return { ...baseResult, outcome: "skipped", attemptCount: attempt.attemptCount, reason: "dry-run" };
  }

  let chargeOk = false;
  let chargeErr: string | undefined;
  let chargePaymentId: string | undefined;
  let chargeOrderId: string | undefined;
  try {
    const user = await getUserById(String(hosting.userId));
    if (!user) {
      throw new Error(`User ${hosting.userId} not found for hosting ${hostingId}`);
    }
    const result = await RazorpayService.chargeViaToken({
      customerId: hosting.razorpayCustomerId,
      tokenId: hosting.razorpayTokenId,
      amountInRupees,
      email: user.email,
      contact: user.phone || "",
      receipt: `mit_${hostingId}_${dueDate.getTime()}`,
      description: `Recurring charge: ${plan.name} (${isYearly ? "yearly" : "monthly"})`,
      notes: { type: "recurring_charge", hosting_id: hostingId, due_date: dueDate.toISOString() },
    });
    chargeOk = true;
    chargePaymentId = result.paymentId;
    chargeOrderId = result.orderId;
  } catch (e: unknown) {
    chargeErr = e instanceof Error ? e.message : String(e);
  }

  // 4. Update attempt + hosting based on outcome
  if (chargeOk) {
    attempt.status = "succeeded";
    attempt.razorpayPaymentId = chargePaymentId;
    attempt.razorpayOrderId = chargeOrderId;
    await attempt.save();

    const newExpiry = new Date(hosting.expiryDate);
    if (isYearly) newExpiry.setFullYear(newExpiry.getFullYear() + 1);
    else newExpiry.setMonth(newExpiry.getMonth() + 1);
    hosting.expiryDate = newExpiry;
    hosting.last_reminder_sent = null;
    await hosting.save();

    serverLogger.info(
      `✅ [RECURRING-CHARGE] Charged ${hosting.domainName}: payment=${chargePaymentId} amount=₹${amountInRupees}; new expiry=${newExpiry.toISOString()}`
    );
    return { ...baseResult, outcome: "succeeded", attemptCount: attempt.attemptCount, newExpiryDate: newExpiry };
  }

  // Charge failed — schedule retry OR abandon
  attempt.lastError = chargeErr;
  if (attempt.attemptCount >= MAX_ATTEMPTS) {
    attempt.status = "abandoned";
    attempt.abandonedAt = now;
    await attempt.save();
    serverLogger.error(
      `❌ [RECURRING-CHARGE] ABANDONED ${hosting.domainName} after ${attempt.attemptCount} attempts: ${chargeErr}.`
    );

    // Phase 2F: dunning + DA suspend on abandonment.
    //
    // Three best-effort actions — each wrapped in try/catch so a single
    // failure (DA unreachable mid-suspend / email transport down / etc.)
    // doesn't cascade. The attempt is already marked 'abandoned', so the
    // cron summary correctly counts this row whatever happens here.

    // (a) Suspend DA user. Skip if directAdminUsername empty (Phase 2C
    // creates Hostings with status='pending' + empty username; Phase 2E
    // cron flips to status='active' + populated username before MIT
    // charges could ever fire, so in practice this guard is defensive).
    if (hosting.directAdminUsername) {
      try {
        const outcome = await daSuspendUser({
          username: hosting.directAdminUsername,
          reason: `Recurring charge abandoned after ${attempt.attemptCount} attempts`,
        });
        if (outcome.kind === "suspended") {
          serverLogger.info(
            `[RECURRING-CHARGE] DA suspended ${hosting.directAdminUsername} (abandoned recurring charge)`
          );
        } else {
          serverLogger.warn(
            `[RECURRING-CHARGE] DA suspend returned ${outcome.kind} for ${hosting.directAdminUsername}: ${outcome.reason ?? ""}`
          );
        }
      } catch (suspendErr) {
        serverLogger.error(
          `[RECURRING-CHARGE] DA suspend threw for ${hosting.directAdminUsername}: ${suspendErr instanceof Error ? suspendErr.message : String(suspendErr)}`
        );
      }
    }

    // (b) Flip Hosting status to 'expired'. The next renewal attempt
    // would be a manual customer action (re-add payment + re-subscribe),
    // not another cron retry.
    hosting.status = "expired";
    hosting.next_action_at = undefined;
    try {
      await hosting.save();
    } catch (saveErr) {
      serverLogger.error(
        `[RECURRING-CHARGE] Failed to flip Hosting.status='expired' for ${hosting.domainName}: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`
      );
    }

    // (c) Send the dunning / suspension email. Customer needs to know
    // their hosting was suspended + how to recover.
    try {
      const user = await getUserById(String(hosting.userId));
      if (user?.email) {
        await EmailService.sendServiceSuspensionEmail(user.email, {
          serviceName: hosting.domainName,
          serviceType: "Hosting",
        });
        serverLogger.info(
          `[RECURRING-CHARGE] Suspension email sent to ${user.email} for ${hosting.domainName}`
        );
      }
    } catch (emailErr) {
      serverLogger.error(
        `[RECURRING-CHARGE] Failed to send suspension email for ${hosting.domainName}: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`
      );
    }

    return { ...baseResult, outcome: "abandoned", attemptCount: attempt.attemptCount, reason: chargeErr };
  }
  const backoffDays = RETRY_BACKOFF_DAYS[Math.min(attempt.attemptCount - 1, RETRY_BACKOFF_DAYS.length - 1)];
  const nextAttempt = new Date(now);
  nextAttempt.setDate(nextAttempt.getDate() + backoffDays);
  attempt.status = "failed";
  attempt.nextAttemptAt = nextAttempt;
  await attempt.save();
  serverLogger.warn(
    `⚠️ [RECURRING-CHARGE] Failed ${hosting.domainName} attempt ${attempt.attemptCount}: ${chargeErr}. Next retry: ${nextAttempt.toISOString()} (+${backoffDays}d)`
  );
  return { ...baseResult, outcome: "retry_scheduled", attemptCount: attempt.attemptCount, reason: chargeErr };
}

/** Whole-month difference between two dates (start inclusive, end exclusive). */
function monthsBetween(start: Date, end: Date): number {
  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth())
  );
}
