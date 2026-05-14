import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import HostingPlan from "@/models/HostingPlan";
import { ZohoBooksService } from "@/lib/zohobooks";
import { serverLogger } from "@/lib/server-logger";
import { isHostingItem } from "@/lib/billing";

export interface IdempotencyContext {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  paymentDetails: any;
  user: any;
  /** Result of the initial Order.findOne({ razorpayOrderId }) lookup, may be null. */
  existingOrder: any | null;
  cartItems: any[];
}

/**
 * Handles already-processed payments (idempotency guard).
 * Returns a NextResponse if this payment was already processed,
 * or null if this is a new payment that should proceed normally.
 */
export async function handleAlreadyProcessedPayment(
  ctx: IdempotencyContext
): Promise<NextResponse | null> {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    paymentDetails,
    user,
    cartItems,
  } = ctx;
  let { existingOrder } = ctx;

  await connectDB();

  if (!existingOrder) {
    existingOrder = await Order.findOne({
      razorpayPaymentId: razorpay_payment_id,
    });
  }

  // F13: Replace client-supplied cart items with the trusted DB order domains.
  let resolvedCartItems = cartItems;
  if (existingOrder?.domains?.length > 0) {
    resolvedCartItems = existingOrder.domains;
  }

  if (!existingOrder) return null;

  serverLogger.warn(
    "⚠️ [PAYMENT-VERIFY] Payment already processed. Order ID:",
    existingOrder.orderId
  );

  // Zoho Books recovery — ensure the invoice exists even on duplicate calls
  try {
    if (existingOrder.zohoInvoiceId) {
      serverLogger.info(
        `⏭️ [PAYMENT-VERIFY] Zoho Invoice already exists for order ${existingOrder.orderId}: ${existingOrder.invoiceNumber}. Skipping.`
      );
    } else {
      serverLogger.info(
        "📊 [PAYMENT-VERIFY] Syncing with Zoho Books (Recovery)..."
      );

      // Enrich cart items with friendly plan names
      for (const item of resolvedCartItems) {
        if (isHostingItem(item) && item.hostingPlan) {
          const planId =
            item.hostingPlan.planId || item.hostingPlan.serverPackage;
          if (planId) {
            try {
              const plan = await HostingPlan.findOne({ planId }).select(
                "name"
              );
              if (plan?.name) item.hostingPlan.name = plan.name;
            } catch (_e) {}
          }
        }
      }

      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const updatedOrder = await Order.findOneAndUpdate(
        {
          _id: existingOrder._id,
          $or: [
            { zohoInvoiceId: { $exists: false } },
            { zohoInvoiceId: "" },
            {
              zohoInvoiceId: "pending_creation",
              updatedAt: { $lt: fiveMinutesAgo },
            },
          ],
        },
        { $set: { zohoInvoiceId: "pending_creation" } },
        { new: true }
      );

      if (!updatedOrder) {
        serverLogger.info(
          `⏭️ [PAYMENT-VERIFY] Zoho Invoice already claimed or exists for order ${existingOrder.orderId}. Skipping.`
        );
      } else {
        serverLogger.info(
          `📊 [PAYMENT-VERIFY] Starting Zoho Invoice creation/sync for order ${existingOrder.orderId}...`
        );
        const zohoService = ZohoBooksService.getInstance();
        try {
          const invoice = await zohoService.createInvoice(
            {
              orderId: existingOrder.orderId,
              razorpayPaymentId: razorpay_payment_id,
              total: paymentDetails.amount,
            },
            user,
            resolvedCartItems.map((item: any) => ({
              ...item,
              periodUnit:
                item.periodUnit ||
                (item.itemType === "hosting" ? "months" : "years"),
            }))
          );

          if (invoice?.invoice_id) {
            await Order.updateOne(
              { _id: existingOrder._id },
              {
                $set: {
                  zohoInvoiceId: invoice.invoice_id,
                  invoiceNumber:
                    invoice.invoice_number || existingOrder.invoiceNumber,
                },
              }
            );
            serverLogger.info(
              `✅ [PAYMENT-VERIFY] Saved Zoho Invoice ID (Recovery): ${invoice.invoice_id}`
            );
          } else {
            await Order.updateOne(
              {
                _id: existingOrder._id,
                zohoInvoiceId: "pending_creation",
              },
              { $unset: { zohoInvoiceId: "" } }
            );
          }
        } catch (innerError) {
          await Order.updateOne(
            {
              _id: existingOrder._id,
              zohoInvoiceId: "pending_creation",
            },
            { $unset: { zohoInvoiceId: "" } }
          );
          throw innerError;
        }
      }
    }
  } catch (zohoError) {
    serverLogger.error(
      "❌ [PAYMENT-VERIFY] Zoho Books Sync Failed (Recovery):",
      zohoError
    );
  }

  return NextResponse.json({
    success: true,
    message: "Payment already processed",
    orderId: existingOrder.orderId,
    invoiceNumber: existingOrder.invoiceNumber,
    registrationResults: existingOrder.domains.map((d: any) => ({
      domainName: d.domainName,
      status: d.status,
      orderId: d.orderId,
      error: d.error,
    })),
    successfulDomains: existingOrder.successfulDomains,
  });
}
