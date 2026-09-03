import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { authorizeCronRequest } from "@/lib/cron-auth";
import {
  getOrderById,
} from "@/lib/services/orders";
import { getUserById } from "@/lib/services/users";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { createPrimaryInvoice } from "@/lib/services/billing/createPrimaryInvoice";
import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import type { CartItem, RazorpayPaymentDetails } from "@/lib/types";
import { validatedBody, z } from "@/lib/api-validation";

const syncZohoInvoiceSchema = z.object({
  orderId: z.string().min(1),
  userId: z.string().min(1),
  serviceType: z.enum(["hosting", "domain"]),
  domainName: z.string().min(1),
  hostingPlanId: z.string().optional(),
  amount: z.number().nonnegative(),
  currency: z.string().min(1).max(8),
  razorpayPaymentId: z.string().min(1),
  durationMonths: z.number().int().positive(),
});

export const dynamic = "force-dynamic";

/**
 * POST /api/workers/sync-zoho-invoice
 *
 * Async background worker invoked via Cloud Tasks to issue the invoice for a
 * completed mandate/autopay renewal (enqueued by `handleSubscriptionCharged`
 * in lib/services/payment/webhook-handlers.ts). Completely decoupled from the
 * payment webhook — invoicing failures here do NOT affect service activation
 * (that already happened).
 *
 * Cloud Tasks will automatically retry on non-2xx responses.
 *
 * The route NAME is historical. As of the Phase 1c audit this worker no longer
 * calls Zoho directly: it goes through `createPrimaryInvoice`, the same
 * chokepoint as the four synchronous call sites, so a renewal gets a primary
 * TI/... tax invoice from our own GST engine, with Zoho as the automatic
 * fallback (gated by ZOHO_INVOICE_FALLBACK_ENABLED, default on). It is deliberately NOT renamed — the path is baked into the
 * enqueue URL in webhook-handlers.ts and into tasks already sitting in the
 * Cloud Tasks queue.
 *
 * Response contract (Cloud Tasks reads only the status code):
 *  - 200 — invoice issued, OR nothing to do (already invoiced by either
 *          engine, claim held by a concurrent request, zero-amount/trial
 *          order, order row missing). Stop retrying.
 *  - 404 — user row missing. Pre-existing behaviour, left as-is: it makes
 *          Cloud Tasks retry, which only helps if the read was a transient
 *          replica miss.
 *  - 500 — both engines failed. Retry.
 *
 * Auth: x-cron-secret header (same as other workers)
 *
 * Payload:
 *  {
 *    orderId: string,         // Order._id (ObjectId string)
 *    userId: string,          // User._id (ObjectId string)
 *    serviceType: "hosting" | "domain",
 *    domainName: string,
 *    hostingPlanId?: string,  // For hosting items
 *    amount: number,
 *    currency: string,
 *    razorpayPaymentId: string,
 *    durationMonths: number,
 *  }
 */
export async function POST(request: NextRequest) {
  try {
    // Auth
    if (!authorizeCronRequest(request)) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const validation = await validatedBody(request, syncZohoInvoiceSchema);
    if (!validation.ok) return validation.response;
    const {
      orderId,
      userId,
      serviceType,
      domainName,
      hostingPlanId,
      amount,
      currency,
      razorpayPaymentId,
      durationMonths,
    } = validation.data;

    // 1. Idempotency guard — has this order already been invoiced?
    const order = await getOrderById(orderId);
    if (!order) {
      serverLogger.warn(`[ZohoWorker] Order ${orderId} not found — skipping`);
      // Return 200 so Cloud Tasks does not retry for a missing order
      return secureJsonResponse({
        success: false,
        message: "Order not found — skipped",
      });
    }

    // A primary-engine invoice legitimately has NO zohoInvoiceId — its tax
    // invoice is our own TI/... number. Without this check, a flag flip-flop
    // (order invoiced by the primary engine, flag later turned OFF, Cloud
    // Tasks retries this task) would send us down the Zoho path and issue a
    // SECOND tax invoice under the same GSTIN for one payment. Same bug
    // class as the admin re-sync guard.
    if (order.invoiceProvider === "primary") {
      serverLogger.info(
        `[ZohoWorker] Order ${orderId} already invoiced by the primary GST engine (${order.invoiceNumber}) — skipping`
      );
      return secureJsonResponse({
        success: true,
        message: "Already invoiced by the primary engine",
        provider: "primary",
        invoiceNumber: order.invoiceNumber,
      });
    }

    if (
      order.zohoInvoiceId &&
      order.zohoInvoiceId !== "pending_creation"
    ) {
      serverLogger.info(
        `[ZohoWorker] Invoice already exists for order ${orderId} (${order.zohoInvoiceId}) — skipping`
      );
      return secureJsonResponse({
        success: true,
        message: "Already synced",
        zohoInvoiceId: order.zohoInvoiceId,
      });
    }

    // 2. Load user
    const user = await getUserById(userId);
    if (!user) {
      serverLogger.error(`[ZohoWorker] User ${userId} not found`);
      return secureErrorResponse("User not found", 404, "USER_NOT_FOUND");
    }

    // 3. Build line items
    let hostingPlan: Awaited<ReturnType<typeof getPlanByPlanId>> = null;
    if (serviceType === "hosting" && hostingPlanId) {
      hostingPlan = await getPlanByPlanId(hostingPlanId);
    }

    const periodUnit = durationMonths === 12 ? "years" : "months";
    const periodQty = durationMonths === 12 ? 1 : durationMonths || 1;

    // `periodUnit` is set explicitly, so the chokepoint's `inferPeriodUnit`
    // pass-through preserves it verbatim.
    const cartItems = [
      {
        itemType: serviceType,
        domainName,
        hostingPlan: hostingPlan || undefined,
        price: amount,
        currency: currency || "INR",
        registrationPeriod: periodQty,
        periodUnit,
      },
    ] as unknown as CartItem[];

    // 4. Issue the invoice through the single chokepoint — primary GST engine
    //    first (always — it is ungated), Zoho as automatic fallback.
    //
    //    NO CLAIM IS TAKEN HERE, deliberately. This worker used to call
    //    `claimOrderForZohoInvoice` itself and then hit Zoho directly. Both
    //    engines behind the chokepoint take their OWN claim, so claiming here
    //    too would make the inner Zoho claim see this worker's own
    //    `pending_creation` sentinel, log "already claimed — skipping", and
    //    return an empty result — the worker would report 200 success having
    //    issued no invoice at all.
    //
    //    `staleClaimAfterMs` matters here in a way it doesn't for the four
    //    synchronous call sites: this worker runs out of band and Cloud Tasks
    //    retries it. Without stealing, a crash between claim and persist
    //    strands the order behind a claim no retry can take, and the renewal
    //    stays permanently uninvoiced. 5 min matches idempotency.ts. Neither
    //    engine can re-issue a COMPLETED invoice regardless — both claims
    //    also filter on the final-outcome field.
    //
    //    `allowNull` preserves the previous behaviour of treating a legacy
    //    `zohoInvoiceId: null` row as unclaimed.
    const paymentDetails = {
      id: razorpayPaymentId,
      amount,
      currency: currency || "INR",
    } as unknown as RazorpayPaymentDetails;

    const result = await createPrimaryInvoice(
      {
        order: order as unknown as IOrder,
        orderId: order.orderId,
        razorpay_payment_id: razorpayPaymentId,
        paymentDetails,
        user: user as unknown as IUser,
        cartItems,
      },
      {
        claimOptions: {
          allowNull: true,
          staleClaimAfterMs: 5 * 60 * 1000,
        },
      }
    );

    // `skipped` means a concurrent request holds the claim, or the order is a
    // zero-amount/trial row. Neither is a failure and neither is fixed by
    // retrying — 200 so Cloud Tasks stops.
    if (result.provider === "skipped") {
      serverLogger.info(
        `[ZohoWorker] Nothing issued for order ${orderId} (already claimed, or zero-amount/trial) — skipping`
      );
      return secureJsonResponse({
        success: true,
        message: "Skipped — already claimed or non-invoiceable order",
        provider: "skipped",
      });
    }

    serverLogger.info(
      `[ZohoWorker] Invoice ${result.invoiceNumber} created for order ${orderId} via ${result.provider}`
    );
    return secureJsonResponse({
      success: true,
      provider: result.provider,
      zohoInvoiceId: result.provider === "zoho" ? result.invoiceId : undefined,
      invoiceNumber: result.invoiceNumber,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[ZohoWorker] Unhandled error:", message);
    // Both engines failed (the chokepoint only throws once Zoho's own retries
    // are exhausted too) and each released its own claim on the way out.
    // Return 500 so Cloud Tasks retries.
    return secureErrorResponse(
      "Internal error during Zoho sync",
      500,
      "ZOHO_SYNC_ERROR"
    );
  }
}
