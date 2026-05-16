import { NextRequest } from "next/server";
import { RazorpayService } from "@/lib/razorpay";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import { redis } from "@/lib/redis";
import {
  handleSubscriptionCharged,
  handleSubscriptionFailed,
} from "@/lib/services/payment/webhook-handlers";

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
