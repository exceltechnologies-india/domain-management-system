import { NextResponse } from "next/server";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { serverLogger } from "@/lib/server-logger";
import { isHostingItem } from "@/lib/billing";
import { getOrderByRazorpayPaymentId, markInvoiceCreationFailed } from "@/lib/services/orders";
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
  // metadata, no min-period field) but the downstream invoice path reads
  // a compatible projection — narrow via `unknown` so the same code handles
  // both shapes without a runtime change.
  let resolvedCartItems: CartItem[] = cartItems;
  if (existingOrder?.domains && existingOrder.domains.length > 0) {
    resolvedCartItems = existingOrder.domains as unknown as CartItem[];
  }

  if (!existingOrder) return null;

  // A `pending` order is the NORMAL pre-payment state: /create-order persists
  // one BEFORE the customer ever reaches Razorpay Checkout. Its mere existence
  // is therefore not evidence the payment was already processed — and treating
  // it as such short-circuits the FIRST, legitimate /verify call, before the
  // atomic claim, finalisation and provisioning ever run.
  //
  // The damage that caused (reproduced by
  // tests/integration/e2e/verify-path-purchase.test.ts): the customer was
  // charged, a legally-numbered TI/... tax invoice WAS issued by the recovery
  // path below, and yet the order stayed `status: "pending"` with
  // `razorpayPaymentId: "pending"` and no Hosting record — a tax document for
  // a service never delivered.
  //
  // It stayed invisible in production because the Razorpay webhook reaches
  // app.anutech.in moments later and completes the order; the pre-existing E2E
  // suite drives that webhook and never exercised /verify. It surfaced on a
  // developer machine, where no webhook can arrive.
  //
  // Falling through here is safe under concurrency: the very next step is
  // `claimPendingOrderForProcessing`, an atomic findOneAndUpdate — exactly one
  // caller wins, and the loser gets the "provisioning in progress" response.
  // Genuine duplicates (processing / paid / completed) still short-circuit
  // below and still get the invoice-recovery pass.
  if (existingOrder.status === "pending") return null;

  serverLogger.warn(
    "⚠️ [PAYMENT-VERIFY] Payment already processed. Order ID:",
    existingOrder.orderId
  );

  // Invoice recovery — ensure the invoice exists even on duplicate calls.
  //
  // TRIAL / ZERO-AMOUNT GUARD: createPrimaryInvoice has the same guard; this
  // copy returns early so a duplicate /verify on a ₹0 trial order (e.g. the
  // payment-success page firing /verify after the tokens webhook has already
  // completed the order) never even builds an invoice payload. See CLAUDE.md
  // "Trial order invoice policy" + the `project_trial_no_invoice` memory. The
  // first real invoice fires at day-15 conversion via the renewal flow.
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
    // Any `invoiceProvider` — our engine's, or a historical Zoho one — means
    // an invoice already exists and this recovery must not issue another.
    const hasInvoice = existingOrder.invoiceProvider;
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
      // genuinely stuck claim would block this
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
  } catch (invoiceError) {
    serverLogger.error(
      "❌ [PAYMENT-VERIFY] Invoice creation failed (Recovery):",
      invoiceError
    );
    // Flag it so the order stays visible to lib/invoice-retry and admin
    // integration-health — a swallowed failure must not also be a silent one.
    await markInvoiceCreationFailed(
      existingOrder._id,
      invoiceError instanceof Error ? invoiceError.message : String(invoiceError)
    ).catch(() => {});
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
