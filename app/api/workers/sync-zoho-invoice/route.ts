import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { authorizeCronRequest } from "@/lib/cron-auth";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { getUserById } from "@/lib/services/users";
import User from "@/models/User";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { ZohoBooksService } from "@/lib/zohobooks";

export const dynamic = "force-dynamic";

/**
 * POST /api/workers/sync-zoho-invoice
 *
 * Async background worker invoked via Cloud Tasks to create a Zoho Books invoice
 * for a completed renewal. Completely decoupled from the payment webhook — Zoho
 * failures here do NOT affect service activation (that already happened).
 *
 * Cloud Tasks will automatically retry on non-2xx responses.
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

    const body = await request.json();
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
    } = body;

    if (!orderId || !userId || !serviceType || !domainName) {
      return secureErrorResponse(
        "Invalid payload — missing required fields",
        400,
        "INVALID_PAYLOAD"
      );
    }

    await connectDB();

    // 1. Check if Zoho invoice already exists (idempotency guard)
    const order = await Order.findById(orderId);
    if (!order) {
      serverLogger.warn(`[ZohoWorker] Order ${orderId} not found — skipping`);
      // Return 200 so Cloud Tasks does not retry for a missing order
      return secureJsonResponse({
        success: false,
        message: "Order not found — skipped",
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

    // 2. Atomic claim — mark as pending so parallel retries don't double-create
    const claimed = await Order.findOneAndUpdate(
      {
        _id: order._id,
        $or: [
          { zohoInvoiceId: { $exists: false } },
          { zohoInvoiceId: null },
          { zohoInvoiceId: "pending_creation" },
        ],
      },
      { $set: { zohoInvoiceId: "pending_creation" } },
      { new: true }
    );

    if (!claimed) {
      serverLogger.info(
        `[ZohoWorker] Claim failed for order ${orderId} — another worker is processing it`
      );
      // Return 200 to stop Cloud Tasks from retrying; the other worker has it
      return secureJsonResponse({ success: true, message: "Already claimed" });
    }

    // 3. Load user
    const user = await getUserById(userId);
    if (!user) {
      // Cleanup claim and let Cloud Tasks retry
      await Order.updateOne(
        { _id: order._id, zohoInvoiceId: "pending_creation" },
        { $unset: { zohoInvoiceId: "" } }
      );
      serverLogger.error(`[ZohoWorker] User ${userId} not found`);
      return secureErrorResponse("User not found", 404, "USER_NOT_FOUND");
    }

    // 4. Build line items
    let hostingPlan: Awaited<ReturnType<typeof getPlanByPlanId>> = null;
    if (serviceType === "hosting" && hostingPlanId) {
      hostingPlan = await getPlanByPlanId(hostingPlanId);
    }

    const periodUnit = durationMonths === 12 ? "years" : "months";
    const periodQty = durationMonths === 12 ? 1 : durationMonths || 1;

    const items = [
      {
        itemType: serviceType,
        domainName: domainName,
        hostingPlan: hostingPlan || undefined,
        price: amount,
        currency: currency || "INR",
        registrationPeriod: periodQty,
        periodUnit,
      },
    ];

    // 5. Create Zoho Invoice
    const zohoService = ZohoBooksService.getInstance();
    const invoice = await zohoService.createInvoice(
      order,
      user,
      items,
      "Razorpay", // paymentMode
      true        // shouldApplyPayment
    );

    if (invoice && invoice.invoice_id) {
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            zohoInvoiceId: invoice.invoice_id,
            invoiceNumber: invoice.invoice_number,
          },
        }
      );
      serverLogger.info(
        `[ZohoWorker] Invoice ${invoice.invoice_number} created for order ${orderId}`
      );
      return secureJsonResponse({
        success: true,
        zohoInvoiceId: invoice.invoice_id,
        invoiceNumber: invoice.invoice_number,
      });
    }

    // Zoho returned null — release the claim and let Cloud Tasks retry
    await Order.updateOne(
      { _id: order._id, zohoInvoiceId: "pending_creation" },
      { $unset: { zohoInvoiceId: "" } }
    );
    serverLogger.warn(`[ZohoWorker] Invoice creation returned null for order ${orderId}`);
    // Return 500 so Cloud Tasks retries this task
    return secureErrorResponse(
      "Zoho invoice creation returned null",
      500,
      "ZOHO_NULL_RESPONSE"
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[ZohoWorker] Unhandled error:", message);
    // Return 500 so Cloud Tasks retries
    return secureErrorResponse(
      "Internal error during Zoho sync",
      500,
      "ZOHO_SYNC_ERROR"
    );
  }
}
