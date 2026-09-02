import { NextResponse } from "next/server";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { serverLogger } from "@/lib/server-logger";
import { isHostingItem } from "@/lib/billing";
import { getOrderByRazorpayPaymentId } from "@/lib/services/orders";
import { createPrimaryInvoice } from "@/lib/services/billing/createPrimaryInvoice";
import type { CartItem, RazorpayPaymentDetails } from "@/lib/types";
import type { IUser } from "@/models/User";
import type { IOrder } from "@/models/Order";

export interface IdempotencyContext {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  paymentDetails: RazorpayPaymentDetails;
  user: IUser;
  /** Result of the initial Order.findOne({ razorpayOrderId }) lookup, may be null. */
  existingOrder: IOrder | null;
  cartItems: CartItem[];
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

  if (!existingOrder) {
    existingOrder = await getOrderByRazorpayPaymentId(razorpay_payment_id);
  }

  // F13: Replace client-supplied cart items with the trusted DB order domains.
  // The order's domain rows aren't strictly typed as CartItem (extra registrar
  // metadata, no min-period field) but the downstream Zoho-invoice path reads
  // a compatible projection — narrow via `unknown` so the same code handles
  // both shapes without a runtime change.
  let resolvedCartItems: CartItem[] = cartItems;
  if (existingOrder?.domains && existingOrder.domains.length > 0) {
    resolvedCartItems = existingOrder.domains as unknown as CartItem[];
  }

  if (!existingOrder) return null;

  serverLogger.warn(
    "⚠️ [PAYMENT-VERIFY] Payment already processed. Order ID:",
    existingOrder.orderId
  );

  // Zoho Books recovery — ensure the invoice exists even on duplicate calls.
  //
  // TRIAL / ZERO-AMOUNT GUARD (mirrors createZohoInvoice in post-tasks.ts):
  // this recovery path calls zohoService.createInvoice DIRECTLY, so the guard
  // in createZohoInvoice does NOT cover it. Without this check a ₹0 trial
  // order (orderType='hosting_trial') that gets a duplicate /verify call —
  // e.g. the payment-success page firing /verify after the tokens webhook has
  // already completed the order — creates a bogus tax invoice for a free
  // trial (Zoho coerces the ₹0 line to a ₹1 minimum). See CLAUDE.md "Trial
  // order invoice policy" + the `project_trial_no_invoice` memory. The first
  // real invoice fires at day-15 conversion via the renewal flow.
  const _amt = existingOrder.amount;
  if (!_amt || _amt <= 0 || existingOrder.orderType === "hosting_trial") {
    serverLogger.info(
      `⏭️ [PAYMENT-VERIFY] Skipping zero-amount/trial invoice for order ${existingOrder.orderId} ` +
      `(amount=${_amt}, orderType=${existingOrder.orderType}) — Trial order invoice policy.`
    );
    return NextResponse.json({
      success: true,
      message: "Payment already processed",
      orderId: existingOrder.orderId,
      invoiceNumber: existingOrder.invoiceNumber,
      registrationResults: existingOrder.domains.map((d: IOrder["domains"][number]) => ({
        domainName: d.domainName,
        status: d.status,
        orderId: d.orderId,
        error: d.error,
      })),
      successfulDomains: existingOrder.successfulDomains,
    });
  }

  try {
    // Covers BOTH engines — an order with a primary-issued invoice has no
    // zohoInvoiceId at all, so checking that field alone would have this
    // recovery path attempt (and duplicate) an invoice that already exists.
    const hasInvoice = existingOrder.zohoInvoiceId || existingOrder.invoiceProvider;
    if (hasInvoice) {
      serverLogger.info(
        `⏭️ [PAYMENT-VERIFY] Invoice already exists for order ${existingOrder.orderId}: ${existingOrder.invoiceNumber}. Skipping.`
      );
    } else {
      serverLogger.info(
        "📊 [PAYMENT-VERIFY] Syncing invoice (Recovery)..."
      );

      // Enrich cart items with friendly plan names
      for (const item of resolvedCartItems) {
        if (isHostingItem(item) && item.hostingPlan) {
          const plan = item.hostingPlan as CartItem["hostingPlan"] & { planId?: string };
          const planId = plan?.planId || plan?.serverPackage;
          if (planId) {
            try {
              const plan = await getPlanByPlanId(planId);
              if (plan?.name) item.hostingPlan.name = plan.name;
            } catch (_e) {}
          }
        }
      }

      // staleClaimAfterMs: this recovery path exists specifically because a
      // prior /verify call may have crashed mid-claim — without it, a
      // genuinely stuck "pending_creation"/primary claim would block this
      // recovery attempt forever instead of being the thing that unsticks it.
      await createPrimaryInvoice(
        {
          order: existingOrder,
          orderId: existingOrder.orderId,
          razorpay_payment_id,
          paymentDetails,
          user,
          cartItems: resolvedCartItems.map((item) => ({
            ...item,
            periodUnit:
              item.periodUnit ||
              (item.itemType === "hosting" ? "months" : "years"),
          })),
        },
        { claimOptions: { staleClaimAfterMs: 5 * 60 * 1000 } }
      );
    }
  } catch (zohoError) {
    serverLogger.error(
      "❌ [PAYMENT-VERIFY] Invoice Sync Failed (Recovery):",
      zohoError
    );
  }

  return NextResponse.json({
    success: true,
    message: "Payment already processed",
    orderId: existingOrder.orderId,
    invoiceNumber: existingOrder.invoiceNumber,
    registrationResults: existingOrder.domains.map((d: IOrder["domains"][number]) => ({
      domainName: d.domainName,
      status: d.status,
      orderId: d.orderId,
      error: d.error,
    })),
    successfulDomains: existingOrder.successfulDomains,
  });
}
