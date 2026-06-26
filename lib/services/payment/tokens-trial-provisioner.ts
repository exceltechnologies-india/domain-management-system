/**
 * Tokens-flow trial provisioner (Phase 2C, narrow scope).
 *
 * Creates a Hosting record from a Tokens-mode CIT-authorized Order. Called
 * inside `handleMandateValidationCaptured` in `app/razorpay/webhook/route.ts`
 * right after the ₹2 mandate-validation refund + token storage.
 *
 * Phase 2C scope is INTENTIONALLY narrow: this function only creates the
 * Hosting record in `status='pending'`. DirectAdmin user creation is
 * deferred to Phase 2D (a separate cron that picks up pending Hostings).
 * The customer can't use the trial until DA provisioning runs — that's a
 * conscious tradeoff to keep this commit small.
 *
 * For the cron to find this Hosting later for the day-15 MIT charge, three
 * fields must be set:
 *  - `expiryDate = now + 15 days` (trial expiry — the cron queries
 *    Hostings where expiryDate <= today + 1 day)
 *  - `razorpayCustomerId` (which customer to debit)
 *  - `razorpayTokenId` (the stored mandate token from the CIT auth)
 *
 * Idempotency: callers should check whether a Hosting already exists for
 * `(userId, domainName)` before calling this — re-running this function
 * on an idempotent webhook retry would create duplicate Hostings.
 */
import type { IOrder } from "@/models/Order";
import { createHosting } from "@/lib/services/hostings";
import { serverLogger } from "@/lib/server-logger";

const TRIAL_DURATION_DAYS = 15;
const FIRST_REMINDER_LEAD_DAYS = 2; // remind 2 days before trial ends

interface TokensOrderShape extends IOrder {
  razorpayCustomerId?: string;
  razorpayTokenId?: string;
}

interface OrderDomainShape {
  domainName?: string;
  hostingPlan?: {
    planId?: string;
    name?: string;
    serverPackage?: string;
  };
}

export interface ProvisionedTokensTrialHosting {
  hostingId: string;
  domainName: string;
  expiryDate: Date;
  status: "pending";
}

/**
 * Create the Hosting row for a Tokens-flow trial. Returns the new
 * Hosting's id + expiry, or throws if the Order is malformed.
 */
export async function createTokensFlowTrialHosting(
  order: TokensOrderShape
): Promise<ProvisionedTokensTrialHosting> {
  if (order.mandateMode !== "tokens") {
    throw new Error(
      `createTokensFlowTrialHosting: refusing — order.mandateMode is '${order.mandateMode}', expected 'tokens'`
    );
  }
  if (!order.razorpayCustomerId || !order.razorpayTokenId) {
    throw new Error(
      `createTokensFlowTrialHosting: refusing — order ${order.orderId} missing razorpayCustomerId or razorpayTokenId; the CIT auth handler should have populated these before calling`
    );
  }

  // The Tokens-flow trial Order persists exactly one hosting item in
  // `domains` — see app/api/payments/create-order/route.ts's Tokens branch.
  const firstDomain = (order.domains as unknown as OrderDomainShape[] | undefined)?.[0];
  if (!firstDomain?.domainName || !firstDomain.hostingPlan?.planId) {
    throw new Error(
      `createTokensFlowTrialHosting: order ${order.orderId} has no hosting item with planId in domains[0]`
    );
  }

  const now = new Date();
  const expiryDate = new Date(now);
  expiryDate.setDate(expiryDate.getDate() + TRIAL_DURATION_DAYS);

  const reminderDate = new Date(expiryDate);
  reminderDate.setDate(reminderDate.getDate() - FIRST_REMINDER_LEAD_DAYS);

  const hosting = await createHosting({
    userId: order.userId,
    domainName: firstDomain.domainName,
    planId: firstDomain.hostingPlan.planId,
    name: firstDomain.hostingPlan.name || "Hosting Plan",
    serverPackage: firstDomain.hostingPlan.serverPackage || firstDomain.hostingPlan.planId,
    // 'pending' = mandate authorized, DA user not yet created. The DA
    // provisioning cron (Phase 2D) picks this up and flips to 'active'.
    status: "pending",
    startDate: now,
    expiryDate,
    // Empty string placeholder. The DA provisioning cron (Phase 2D)
    // overwrites this with the actual DA username on user creation.
    // Hosting.directAdminUsername is required in the schema, so we set
    // an empty string rather than undefined.
    directAdminUsername: "",
    orderId: order.orderId,
    paymentId: (order as IOrder & { razorpayPaymentId?: string }).razorpayPaymentId,
    // No Razorpay subscription_id in Tokens flow — that's the whole point.
    // billingType: 'subscription' because we DO have recurring mandate
    // (via Tokens API), even though we're not using Razorpay Subscriptions.
    billingType: "subscription",
    isTrial: true,
    autoRenew: true,
    razorpayCustomerId: order.razorpayCustomerId,
    razorpayTokenId: order.razorpayTokenId,
    next_action_at: reminderDate,
    last_reminder_sent: null,
  });

  serverLogger.info(
    `✅ [TOKENS-TRIAL] Hosting created (pending DA provisioning): id=${String(hosting._id)} domain=${firstDomain.domainName} expiry=${expiryDate.toISOString()} customer=${order.razorpayCustomerId} token=${order.razorpayTokenId}`
  );

  return {
    hostingId: String(hosting._id),
    domainName: firstDomain.domainName,
    expiryDate,
    status: "pending",
  };
}
