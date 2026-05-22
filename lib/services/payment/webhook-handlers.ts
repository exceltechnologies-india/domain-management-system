import type { IOrder } from "@/models/Order";
import { getUserById } from "@/lib/services/users";
import Hosting from "@/models/Hosting";
import type { HydratedDocument } from "mongoose";
import { getPlanByRazorpaySubscriptionPlanId } from "@/lib/services/hosting-plans";
import { findUserHosting, getHostingById } from "@/lib/services/hostings";
import { createRenewalOrder } from "@/lib/services/orders";
import {
  attachOrderToRenewal,
  claimRenewalPayment,
  getRenewalByProviderPaymentId,
  recordRenewalPayment,
  releaseRenewalClaim,
} from "@/lib/services/renewal-payments";
import { serverLogger } from "@/lib/server-logger";
import { EmailService } from "@/lib/email";
import { createHttpTask } from "@/lib/cloud-tasks";
import { DirectAdminService as DA } from "@/lib/directadmin";

/**
 * Razorpay webhook event handlers. Pure business logic — the HTTP-layer
 * concerns (signature verification, age gate, redis nonce, error response
 * shape) live in app/api/webhooks/razorpay/route.ts. These handlers throw
 * on unexpected errors; the route catches and returns the generic 500
 * response so internal structure never leaks.
 */

/** Razorpay webhook payload — only the fields these handlers read. */
interface RazorpayWebhookPayload {
  payload: {
    payment: {
      entity: {
        id: string;
        amount: number;
        currency: string;
        order_id?: string;
      };
    };
    subscription: {
      entity: {
        id: string;
        plan_id: string;
        notes?: { user_id?: string; domain_name?: string };
      };
    };
  };
}

/** Mongoose duplicate-key error code, plus generic Error.message. */
interface MongoLikeError {
  code?: number;
  message?: string;
}

function asErr(err: unknown): MongoLikeError {
  if (err && typeof err === "object") return err as MongoLikeError;
  return { message: String(err) };
}

export async function handleSubscriptionCharged(payload: RazorpayWebhookPayload) {
  const payment = payload.payload.payment.entity;
  const subscription = payload.payload.subscription.entity;

  const userId = subscription.notes?.user_id;
  const domainName = subscription.notes?.domain_name;

  if (!userId || !domainName) {
    serverLogger.error("[Webhook] Missing userId or domainName in subscription notes");
    return;
  }

  const razorpayPaymentId: string = payment.id;

  serverLogger.info(
    `[Webhook] subscription.charged — user=${userId} domain=${domainName} paymentId=${razorpayPaymentId}`
  );

  // ── Step 1: Determine plan & duration ─────────────────────────────────────
  const hostingPlan = await getPlanByRazorpaySubscriptionPlanId(subscription.plan_id);

  const isMonthly = hostingPlan?.razorpayPlans?.monthly === subscription.plan_id;
  const renewalDurationMonths = isMonthly ? 1 : 12;

  // ── Step 2: Store RenewalPayment (idempotency anchor) ─────────────────────
  // The unique index on providerPaymentId silently ignores duplicate inserts.
  try {
    const hosting = await findUserHosting(userId, { domainName });
    if (!hosting) {
      serverLogger.error(
        `[Webhook] Hosting not found for user=${userId} domain=${domainName} paymentId=${razorpayPaymentId}`
      );
      // Alert admin — customer was charged but no Hosting record exists to renew
      const adminEmail = process.env.ADMIN_EMAIL ?? "sales@anutech.in";
      EmailService.sendAdminNotification(
        adminEmail,
        "Subscription charge received but Hosting not found",
        "Razorpay fired <strong>subscription.charged</strong> but no Hosting record exists for this user/domain. Manual action required: create the Hosting record or issue a refund.",
        { userId, domainName, paymentId: razorpayPaymentId, subscriptionId: subscription.id, amount: `₹${payment.amount / 100}` }
      ).catch((alertErr: unknown) =>
        serverLogger.error(`[Webhook] Failed to send admin alert: ${asErr(alertErr).message}`)
      );
      return;
    }

    await recordRenewalPayment({
      serviceId: hosting._id,
      serviceType: "hosting",
      providerPaymentId: razorpayPaymentId,
      subscriptionId: subscription.id,
      amount: payment.amount / 100, // Convert paise → INR
      currency: payment.currency,
      renewalDurationMonths,
    });

    serverLogger.info(
      `[Webhook] RenewalPayment stored for ${razorpayPaymentId} (processed=false)`
    );
  } catch (err: unknown) {
    const e = asErr(err);
    // E11000 duplicate key = already exists; this is expected on retries
    if (e.code === 11000) {
      serverLogger.info(
        `[Webhook] RenewalPayment already exists for ${razorpayPaymentId} — checking if processed`
      );
    } else {
      serverLogger.error(`[Webhook] Failed to store RenewalPayment: ${e.message}`);
      return;
    }
  }

  // ── Step 3: Idempotency check ──────────────────────────────────────────────
  const renewal = await getRenewalByProviderPaymentId(razorpayPaymentId);

  if (!renewal) {
    serverLogger.error(`[Webhook] RenewalPayment not found after insert for ${razorpayPaymentId}`);
    return;
  }

  if (renewal.processed) {
    serverLogger.info(
      `[Webhook] RenewalPayment ${razorpayPaymentId} already processed — skipping`
    );
    return;
  }

  // ── Step 4: Atomic claim ───────────────────────────────────────────────────
  // Only one worker (even across retries) will successfully set processed=true
  const claimed = await claimRenewalPayment(razorpayPaymentId);

  if (!claimed) {
    serverLogger.info(
      `[Webhook] RenewalPayment ${razorpayPaymentId} was claimed by another worker — skipping`
    );
    return;
  }

  // ── Step 5: Load service and user ─────────────────────────────────────────
  const [hosting, user] = await Promise.all([
    getHostingById(String(renewal.serviceId)),
    getUserById(userId),
  ]);

  if (!hosting || !user) {
    serverLogger.error(
      `[Webhook] Hosting or user not found after claim — paymentId=${razorpayPaymentId}`
    );
    // Rollback claim so it can be retried
    await releaseRenewalClaim(razorpayPaymentId);
    return;
  }

  const now = new Date();

  // ── Step 6: Renewal logic ─────────────────────────────────────────────────
  /**
   * Rule: Payment Always Wins.
   * - If active/expiring_soon → add-on model (extend from current expiry)
   * - If grace/suspended → hard reset (start fresh from now)
   */
  const wasInactive = ["expired", "failed", "terminated"].includes(hosting.status);

  if (wasInactive) {
    // Reset expiry from now
    const newExpiry = new Date(now);
    if (isMonthly) {
      newExpiry.setMonth(newExpiry.getMonth() + 1);
    } else {
      newExpiry.setFullYear(newExpiry.getFullYear() + 1);
    }
    hosting.expiryDate = newExpiry;

    // Unsuspend on DirectAdmin if it was expired/suspended
    if (hosting.status === "expired" && hosting.directAdminUsername) {
      try {
        await DA.unsuspendUser(hosting.directAdminUsername);
        serverLogger.info(`[Webhook] Unsuspended DA user: ${hosting.directAdminUsername}`);
      } catch (daErr: unknown) {
        serverLogger.error(
          `[Webhook] Failed to unsuspend DA user ${hosting.directAdminUsername}: ${asErr(daErr).message}`
        );
        // Don't abort — DB update is the source of truth
      }
    }
  } else {
    // Add-on model: extend from current expiry date
    const fromDate = new Date(hosting.expiryDate);
    if (isMonthly) {
      fromDate.setMonth(fromDate.getMonth() + 1);
    } else {
      fromDate.setFullYear(fromDate.getFullYear() + 1);
    }
    hosting.expiryDate = fromDate;
  }

  // ── Step 7: Reset lifecycle fields ───────────────────────────────────────
  hosting.status = "active";
  hosting.last_reminder_sent = null;
  hosting.processing_until = null;

  // Trial → paid transition: on the first real charge, reset expiry to now+1 year
  // and clear the trial flag. The trial expiry (15 days) must not be used as the
  // base for renewal extension — hard reset to now instead.
  // `isTrial` is a runtime field that the hosting flow toggles but isn't
  // declared on IHosting. Narrow cast at this call site only.
  const hostingWithTrial = hosting as unknown as { isTrial?: boolean };
  if (hostingWithTrial.isTrial) {
    hostingWithTrial.isTrial = false;
    const newExpiry = new Date();
    newExpiry.setFullYear(newExpiry.getFullYear() + 1);
    hosting.expiryDate = newExpiry;
    serverLogger.info(`[Webhook] Trial converted to paid for ${domainName} — new expiry=${newExpiry.toISOString()}`);
  }

  // Schedule first reminder 15 days before the new expiry
  hosting.next_action_at = new Date(
    hosting.expiryDate.getTime() - 15 * 24 * 60 * 60 * 1000
  );
  hosting.paymentId = payment.id;
  hosting.subscriptionId = subscription.id;

  await hosting.save();

  serverLogger.info(
    `[Webhook] Renewal applied for ${domainName} — ` +
    `new expiry=${hosting.expiryDate.toISOString()} wasInactive=${wasInactive}`
  );

  // ── Step 8: Create Order record (audit trail) ─────────────────────────────
  let newOrder: HydratedDocument<IOrder> | null = null;

  try {
    newOrder = await createRenewalOrder({
      user,
      payment,
      subscriptionId: subscription.id,
      domainName,
      isMonthly,
      hostingPlan: hostingPlan
        ? {
            planId: hostingPlan.planId,
            name: hostingPlan.name,
            serverPackage: hostingPlan.directAdminPackage,
          }
        : undefined,
    });

    // Link orderId back to the RenewalPayment record for cross-referencing
    await attachOrderToRenewal(razorpayPaymentId, String(newOrder._id));
  } catch (orderErr: unknown) {
    // Order creation failure is non-critical — service is already renewed
    serverLogger.error(`[Webhook] Failed to create Order record: ${asErr(orderErr).message}`);
  }

  // ── Step 9: Async Zoho accounting sync ───────────────────────────────────
  /**
   * Rule: No Dependency on Zoho.
   * Fire and forget — Zoho errors NEVER affect service activation.
   * Cloud Tasks handles retries automatically.
   */
  if (newOrder) {
    const zohoQueueName = process.env.GCP_ZOHO_QUEUE_NAME || process.env.GCP_QUEUE_NAME || "service-expiry-queue";
    const zohoWorkerUrl = `${process.env.NEXTAUTH_URL}/api/v1/workers/sync-zoho-invoice`;

    createHttpTask(zohoQueueName, zohoWorkerUrl, {
      orderId: newOrder._id.toString(),
      userId: user._id.toString(),
      serviceType: "hosting",
      domainName,
      hostingPlanId: hostingPlan?.planId,
      amount: payment.amount / 100,
      currency: payment.currency,
      razorpayPaymentId: payment.id,
      durationMonths: renewalDurationMonths,
    }).catch((err) =>
      serverLogger.error(
        `[Webhook] Failed to queue Zoho sync task: ${err.message}`
      )
    );
  }
}

export async function handleSubscriptionFailed(payload: RazorpayWebhookPayload) {
  const subscription = payload.payload.subscription.entity;
  const userId = subscription.notes?.user_id;
  const domainName = subscription.notes?.domain_name;

  if (!userId || !domainName) return;

  serverLogger.warn(
    `[Webhook] subscription.payment_failed — user=${userId} domain=${domainName}. APPLYING STRICT EXPIRY.`
  );

  try {
    const hosting = await findUserHosting(userId, { domainName });
    if (!hosting) return;

    // Immediately expire the service
    hosting.status = "expired";
    hosting.billingType = "manual"; // Auto-renew failed, must be recovered manually
    hosting.next_action_at = undefined; // Prevent scheduler from re-queuing the already-expired service
    await hosting.save();

    // Instantly suspend on DirectAdmin
    if (hosting.directAdminUsername) {
      await DA.suspendUser(hosting.directAdminUsername);
      serverLogger.info(`[Webhook] Suspended DA user immediately: ${hosting.directAdminUsername}`);
    }
  } catch (err: unknown) {
    serverLogger.error(`[Webhook] Failed to process immediate expiration: ${asErr(err).message}`);
  }
}
