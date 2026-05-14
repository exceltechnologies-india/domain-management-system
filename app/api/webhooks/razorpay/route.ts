import { NextRequest } from "next/server";
import { RazorpayService } from "@/lib/razorpay";
import Order from "@/models/Order";
import User from "@/models/User";
import Hosting from "@/models/Hosting";
import HostingPlan from "@/models/HostingPlan";
import RenewalPayment from "@/models/RenewalPayment";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { EmailService } from "@/lib/email";
import { createHttpTask } from "@/lib/cloud-tasks";
import { DirectAdminService as DA } from "@/lib/directadmin";
import connectDB from "@/lib/mongodb";
import { redis } from "@/lib/redis";

// Maximum age of a webhook event we will process (24 h covers all Razorpay retry attempts)
const WEBHOOK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Redis nonce TTL — fast deduplication window before the DB is touched
const WEBHOOK_NONCE_TTL_S = 15 * 60;

// Force dynamic rendering
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get("x-razorpay-signature");
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!signature || !secret) {
      return secureErrorResponse("Missing signature or secret", 400, "WEBHOOK_CONFIG_ERROR");
    }

    /**
     * 🛡️ Security Layer 1 — Signature Verification
     * Confirms the request originated from Razorpay using the shared secret.
     */
    const isValid = RazorpayService.verifyWebhookSignature(body, signature, secret);
    if (!isValid) {
      return secureErrorResponse("Invalid signature", 400, "INVALID_SIGNATURE");
    }

    const payload = JSON.parse(body);
    const event = payload.event;

    /**
     * 🛡️ Security Layer 2 — Timestamp gate
     * Reject events older than 24 h. Covers all Razorpay retry windows while
     * blocking genuine replay attacks from captured old webhooks.
     * Return 200 so Razorpay does not keep retrying a stale event.
     */
    const eventCreatedAt: number | undefined = payload.created_at;
    if (eventCreatedAt) {
      const ageMs = Date.now() - eventCreatedAt * 1000;
      if (ageMs > WEBHOOK_MAX_AGE_MS) {
        serverLogger.warn(
          `[Webhook] Stale event rejected — event=${event} age=${Math.round(ageMs / 1000)}s`
        );
        return secureJsonResponse({ status: "ok" });
      }
    }

    /**
     * 🛡️ Security Layer 3 — Redis nonce
     * Fast deduplication before the database is touched. The SET NX is atomic:
     * only the first delivery within the TTL window can claim the key.
     * Longer-lived duplicates are still caught by the MongoDB processed flag.
     */
    const paymentId = payload.payload?.payment?.entity?.id;
    if (paymentId && event) {
      const nonceKey = `webhook:nonce:${event}:${paymentId}`;
      try {
        const claimed = await redis.set(nonceKey, "1", "EX", WEBHOOK_NONCE_TTL_S, "NX");
        if (claimed === null) {
          serverLogger.info(
            `[Webhook] Duplicate rejected via Redis nonce — event=${event} paymentId=${paymentId}`
          );
          return secureJsonResponse({ status: "ok" });
        }
      } catch (redisErr: any) {
        // Redis unavailable — fall through to MongoDB idempotency as the backstop
        serverLogger.warn(`[Webhook] Redis nonce check failed, proceeding: ${redisErr.message}`);
      }
    }

    await connectDB();

    if (event === "subscription.charged") {
      await handleSubscriptionCharged(payload);
    } else if (event === "subscription.payment_failed") {
      await handleSubscriptionFailed(payload);
    }

    /**
     * 🛡️ Security Layer 4 — Always return 200 once verified.
     * Prevents Razorpay from retrying on internal processing errors.
     */
    return secureJsonResponse({ status: "ok" });
  } catch (error: any) {
    /**
     * 🛡️ Security Layer 5 — Generic error message.
     * Never leak internal DB/logic structure in webhook responses.
     */
    serverLogger.error("[Webhook] Unhandled error:", error.message);
    return secureErrorResponse("Webhook processing failed", 500, "WEBHOOK_ERROR");
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleSubscriptionCharged(payload: any) {
  const payment = payload.payload.payment.entity;
  const subscription = payload.payload.subscription.entity;

  const userId: string = subscription.notes?.user_id;
  const domainName: string = subscription.notes?.domain_name;

  if (!userId || !domainName) {
    serverLogger.error("[Webhook] Missing userId or domainName in subscription notes");
    return;
  }

  const razorpayPaymentId: string = payment.id;

  serverLogger.info(
    `[Webhook] subscription.charged — user=${userId} domain=${domainName} paymentId=${razorpayPaymentId}`
  );

  // ── Step 1: Determine plan & duration ─────────────────────────────────────
  const hostingPlan = await HostingPlan.findOne({
    $or: [
      { "razorpayPlans.monthly": subscription.plan_id },
      { "razorpayPlans.yearly": subscription.plan_id },
    ],
  });

  const isMonthly = hostingPlan?.razorpayPlans?.monthly === subscription.plan_id;
  const renewalDurationMonths = isMonthly ? 1 : 12;

  // ── Step 2: Store RenewalPayment (idempotency anchor) ─────────────────────
  // The unique index on providerPaymentId silently ignores duplicate inserts.
  try {
    const hosting = await Hosting.findOne({ userId, domainName });
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
      ).catch((alertErr: any) =>
        serverLogger.error(`[Webhook] Failed to send admin alert: ${alertErr.message}`)
      );
      return;
    }

    await RenewalPayment.create({
      serviceId: hosting._id,
      serviceType: "hosting",
      providerPaymentId: razorpayPaymentId,
      subscriptionId: subscription.id,
      amount: payment.amount / 100, // Convert paise → INR
      currency: payment.currency,
      status: "success",
      processed: false,
      renewalDurationMonths,
    });

    serverLogger.info(
      `[Webhook] RenewalPayment stored for ${razorpayPaymentId} (processed=false)`
    );
  } catch (err: any) {
    // E11000 duplicate key = already exists; this is expected on retries
    if (err.code === 11000) {
      serverLogger.info(
        `[Webhook] RenewalPayment already exists for ${razorpayPaymentId} — checking if processed`
      );
    } else {
      serverLogger.error(
        `[Webhook] Failed to store RenewalPayment: ${err.message}`
      );
      return;
    }
  }

  // ── Step 3: Idempotency check ──────────────────────────────────────────────
  const renewal = await RenewalPayment.findOne({
    providerPaymentId: razorpayPaymentId,
  });

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
  const claimed = await RenewalPayment.findOneAndUpdate(
    { providerPaymentId: razorpayPaymentId, processed: false },
    { $set: { processed: true, processedAt: new Date() } },
    { new: true }
  );

  if (!claimed) {
    serverLogger.info(
      `[Webhook] RenewalPayment ${razorpayPaymentId} was claimed by another worker — skipping`
    );
    return;
  }

  // ── Step 5: Load service and user ─────────────────────────────────────────
  const [hosting, user] = await Promise.all([
    Hosting.findById(renewal.serviceId),
    User.findById(userId),
  ]);

  if (!hosting || !user) {
    serverLogger.error(
      `[Webhook] Hosting or user not found after claim — paymentId=${razorpayPaymentId}`
    );
    // Rollback claim so it can be retried
    await RenewalPayment.updateOne(
      { providerPaymentId: razorpayPaymentId },
      { $set: { processed: false }, $unset: { processedAt: "" } }
    );
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
      } catch (daErr: any) {
        serverLogger.error(
          `[Webhook] Failed to unsuspend DA user ${hosting.directAdminUsername}: ${daErr.message}`
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
  if ((hosting as any).isTrial) {
    (hosting as any).isTrial = false;
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
  const orderId = `ORD-RNW-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  let newOrder: any = null;

  try {
    newOrder = new Order({
      orderId,
      userId: user._id,
      userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
      userEmail: user.email,
      paymentId: payment.id,
      razorpayOrderId: payment.order_id || subscription.id,
      razorpayPaymentId: payment.id,
      razorpaySignature: "webhook_verified",
      amount: payment.amount / 100,
      currency: payment.currency,
      status: "completed",
      orderType: "renewal",
      domains: [
        {
          domainName,
          price: payment.amount / 100,
          currency: payment.currency,
          registrationPeriod: isMonthly ? 1 : 12,
          periodUnit: isMonthly ? "months" : "years",
          status: "registered",
          itemType: "hosting",
          hostingPlan: hostingPlan
            ? {
                planId: hostingPlan.planId,
                name: hostingPlan.name,
                serverPackage: hostingPlan.directAdminPackage,
              }
            : undefined,
        },
      ],
      successfulDomains: [domainName],
      paymentVerification: {
        verifiedAt: new Date(),
        paymentStatus: "captured",
        paymentAmount: payment.amount / 100,
        paymentCurrency: payment.currency,
        razorpayOrderId: payment.order_id || subscription.id,
      },
    });

    await newOrder.save();

    // Link orderId back to the RenewalPayment record for cross-referencing
    await RenewalPayment.updateOne(
      { providerPaymentId: razorpayPaymentId },
      { $set: { orderId: newOrder._id.toString() } }
    );
  } catch (orderErr: any) {
    // Order creation failure is non-critical — service is already renewed
    serverLogger.error(`[Webhook] Failed to create Order record: ${orderErr.message}`);
  }

  // ── Step 9: Async Zoho accounting sync ───────────────────────────────────
  /**
   * Rule: No Dependency on Zoho.
   * Fire and forget — Zoho errors NEVER affect service activation.
   * Cloud Tasks handles retries automatically.
   */
  if (newOrder) {
    const zohoQueueName = process.env.GCP_ZOHO_QUEUE_NAME || process.env.GCP_QUEUE_NAME || "service-expiry-queue";
    const zohoWorkerUrl = `${process.env.NEXTAUTH_URL}/api/workers/sync-zoho-invoice`;

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

// ─────────────────────────────────────────────────────────────────────────────

async function handleSubscriptionFailed(payload: any) {
  const subscription = payload.payload.subscription.entity;
  const userId = subscription.notes?.user_id;
  const domainName = subscription.notes?.domain_name;

  if (!userId || !domainName) return;

  serverLogger.warn(
    `[Webhook] subscription.payment_failed — user=${userId} domain=${domainName}. APPLYING STRICT EXPIRY.`
  );

  try {
    const hosting = await Hosting.findOne({ userId, domainName });
    if (!hosting) return;

    // Immediately expire the service
    hosting.status = "expired";
    hosting.billingType = "manual"; // Auto-renew failed, must be recovered manually
    hosting.next_action_at = null; // Prevent scheduler from re-queuing the already-expired service
    await hosting.save();

    // Instantly suspend on DirectAdmin
    if (hosting.directAdminUsername) {
      await DA.suspendUser(hosting.directAdminUsername);
      serverLogger.info(`[Webhook] Suspended DA user immediately: ${hosting.directAdminUsername}`);
    }
  } catch (err: any) {
    serverLogger.error(`[Webhook] Failed to process immediate expiration: ${err.message}`);
  }
}
