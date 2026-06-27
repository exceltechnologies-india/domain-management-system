/**
 * Manual-flow trial provisioner.
 *
 * Creates a Hosting record for a customer who signed up via the
 * "no-mandate" trial path (`HOSTING_MANDATE_FLOW=manual`). Unlike the
 * Tokens-flow provisioner (which fires AFTER a Razorpay CIT auth +
 * mandate-validation refund), this one fires inline from
 * `app/api/payments/create-order/route.ts` at signup time — the
 * customer never goes through Razorpay Checkout for trial setup.
 *
 * Why this exists: while Razorpay UPI Autopay activation is still
 * pending (~2026-07-08) AND eSign is still pending (~2026-06-27),
 * trial signups that pick UPI from Razorpay's overlay would fail at
 * mandate creation. The operator's call is to ship a no-mandate
 * trial path that captures the customer + lets them use hosting
 * immediately, with manual payment reminder at trial-end. Once UPI
 * Autopay activates, the operator flips `HOSTING_MANDATE_FLOW=tokens`
 * and new signups go through the mandate-at-signup flow again.
 *
 * Trade-offs accepted:
 *   - Trial-to-paid conversion will be lower (5-15% range, vs 50-70%
 *     for card-at-signup trials). Operator-aware.
 *   - DA provisioning happens for every trial signup, including the
 *     ones who never convert. Same as the existing Subscriptions-flow
 *     trial cost.
 *   - Customer expectation set via dashboard + reminder emails (the
 *     existing `next_action_at` cron handles reminder scheduling).
 *
 * Idempotency: callers should check whether a Hosting already exists
 * for `(userId, domainName)` before calling this — re-running this
 * function on a retried request would create duplicate Hostings.
 */
import { createHosting } from "@/lib/services/hostings";
import { serverLogger } from "@/lib/server-logger";

const TRIAL_DURATION_DAYS = 15;
const FIRST_REMINDER_LEAD_DAYS = 2;

export interface ManualTrialInputs {
  userId: string;
  domainName: string;
  planId: string;
  planName: string;
  serverPackage?: string;
  orderId: string;
}

export interface ProvisionedManualTrialHosting {
  hostingId: string;
  domainName: string;
  expiryDate: Date;
  status: "pending";
}

export async function createManualFlowTrialHosting(
  input: ManualTrialInputs
): Promise<ProvisionedManualTrialHosting> {
  const now = new Date();
  const expiryDate = new Date(now);
  expiryDate.setDate(expiryDate.getDate() + TRIAL_DURATION_DAYS);

  const reminderDate = new Date(expiryDate);
  reminderDate.setDate(reminderDate.getDate() - FIRST_REMINDER_LEAD_DAYS);

  const hosting = await createHosting({
    userId: input.userId,
    domainName: input.domainName,
    planId: input.planId,
    name: input.planName || "Hosting Plan",
    serverPackage: input.serverPackage || input.planId,
    // 'pending' = signed up, DA user not yet created. The DA
    // provisioning cron (Phase 2E) picks this up and flips to 'active'.
    // Same cron path that Tokens-flow uses; no separate cron needed.
    status: "pending",
    startDate: now,
    expiryDate,
    directAdminUsername: "",
    orderId: input.orderId,
    // Manual flow has no Razorpay payment / mandate at all. Renewals
    // are operator/customer initiated via the existing renewal flow
    // at /api/user/hosting/renew.
    billingType: "manual",
    isTrial: true,
    autoRenew: false, // manual mode means customer chooses when to pay
    next_action_at: reminderDate,
    last_reminder_sent: null,
  });

  serverLogger.info(
    `✅ [MANUAL-TRIAL] Hosting created (pending DA provisioning): id=${String(hosting._id)} domain=${input.domainName} expiry=${expiryDate.toISOString()} (mandateMode=manual, no Razorpay)`
  );

  return {
    hostingId: String(hosting._id),
    domainName: input.domainName,
    expiryDate,
    status: "pending",
  };
}
