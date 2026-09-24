import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { authorizeCronRequest } from "@/lib/cron-auth";
import {
  getOrderById,
  markInvoiceCreationFailed,
} from "@/lib/services/orders";
import { getUserById } from "@/lib/services/users";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { createPrimaryInvoice } from "@/lib/services/billing/createPrimaryInvoice";
import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import type { CartItem, RazorpayPaymentDetails } from "@/lib/types";
import { validatedBody, z } from "@/lib/api-validation";

const issueInvoiceSchema = z.object({
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
 * POST /api/workers/issue-invoice
 *
 * Async background worker invoked via Cloud Tasks to issue the invoice for a
 * completed mandate/autopay renewal (enqueued by `handleSubscriptionCharged`
 * in lib/services/payment/webhook-handlers.ts). Completely decoupled from the
 * payment webhook — invoicing failures here do NOT affect service activation
 * (that already happened).
 *
 * It goes through `createPrimaryInvoice`, the same chokepoint as every other
 * invoicing call site, so a renewal gets a TI/... tax invoice from our own GST
 * engine. Until 24 Sep 2026 this route was `/workers/sync-zoho-invoice`; it
 * was renamed when Zoho Books was removed. Production held 0 renewal orders at
 * the time, so no queued task pointed at the old path.
 *
 * Response contract (Cloud Tasks reads only the status code):
 *  - 200 — invoice issued, OR nothing to do (already invoiced, claim held by
 *          a concurrent request, zero-amount/trial order, order row missing).
 *          Stop retrying.
 *  - 404 — user row missing. Makes Cloud Tasks retry, which only helps if the
 *          read was a transient replica miss.
 *  - 500 — the engine failed. The order is flagged `invoiceFailedAt` so it is
 *          visible in admin integration-health even if every retry fails.
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

    const validation = await validatedBody(request, issueInvoiceSchema);
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
      serverLogger.warn(`[InvoiceWorker] Order ${orderId} not found — skipping`);
      // Return 200 so Cloud Tasks does not retry for a missing order
      return secureJsonResponse({
        success: false,
        message: "Order not found — skipped",
      });
    }

    // Already invoiced — by our engine, or historically by Zoho Books
    // (`invoiceProvider: "zoho"`, stamped by migration 009). Either way a
    // second invoice for the same payment would double-bill under one GSTIN.
    // The engine's own claim refuses this case too; checking here gives the
    // clearer log line and a 200 that stops Cloud Tasks.
    if (order.invoiceProvider) {
      serverLogger.info(
        `[InvoiceWorker] Order ${orderId} already invoiced (${order.invoiceProvider}, ${order.invoiceNumber}) — skipping`
      );
      return secureJsonResponse({
        success: true,
        message: "Already invoiced",
        provider: order.invoiceProvider,
        invoiceNumber: order.invoiceNumber,
      });
    }

    // 2. Load user
    const user = await getUserById(userId);
    if (!user) {
      serverLogger.error(`[InvoiceWorker] User ${userId} not found`);
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

    // 4. Issue the invoice through the single chokepoint.
    //
    //    NO CLAIM IS TAKEN HERE, deliberately — the engine takes its own, and
    //    a second claim here would make it see this worker's claim and skip,
    //    reporting 200 with no invoice issued.
    //
    //    `staleClaimAfterMs` matters here in a way it doesn't for the
    //    synchronous call sites: this worker runs out of band and Cloud Tasks
    //    retries it. Without stealing, a crash between claim and persist
    //    strands the order behind a claim no retry can take. 5 min matches
    //    idempotency.ts. A COMPLETED invoice can never be stolen — the claim
    //    also filters on `invoiceProvider`.
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
      { claimOptions: { staleClaimAfterMs: 5 * 60 * 1000 } }
    ).catch(async (err: unknown) => {
      // Flag it before rethrowing, so the order shows in integration-health
      // and lib/invoice-retry even if every Cloud Tasks retry also fails.
      await markInvoiceCreationFailed(
        order._id,
        err instanceof Error ? err.message : String(err)
      ).catch((markErr: unknown) =>
        serverLogger.error(
          `[InvoiceWorker] ALSO failed to flag order ${orderId} as uninvoiced: ` +
            (markErr instanceof Error ? markErr.message : String(markErr))
        )
      );
      throw err;
    });

    // `skipped` means a concurrent request holds the claim, or the order is a
    // zero-amount/trial row. Neither is a failure and neither is fixed by
    // retrying — 200 so Cloud Tasks stops.
    if (result.provider === "skipped") {
      serverLogger.info(
        `[InvoiceWorker] Nothing issued for order ${orderId} (already claimed, or zero-amount/trial) — skipping`
      );
      return secureJsonResponse({
        success: true,
        message: "Skipped — already claimed or non-invoiceable order",
        provider: "skipped",
      });
    }

    serverLogger.info(
      `[InvoiceWorker] Invoice ${result.invoiceNumber} created for order ${orderId} via ${result.provider}`
    );
    return secureJsonResponse({
      success: true,
      provider: result.provider,
      invoiceNumber: result.invoiceNumber,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[InvoiceWorker] Unhandled error:", message);
    // The engine failed and released its claim on the way out; the order is
    // flagged invoiceFailedAt above. Return 500 so Cloud Tasks retries.
    return secureErrorResponse(
      "Internal error while issuing the invoice",
      500,
      "INVOICE_ISSUE_ERROR"
    );
  }
}
