import { NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";
import { getOrderByRazorpayPaymentId } from "@/lib/services/orders";
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
  const { razorpay_payment_id } = ctx;
  let { existingOrder } = ctx;

  if (!existingOrder) {
    existingOrder = await getOrderByRazorpayPaymentId(razorpay_payment_id);
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
  // below.
  if (existingOrder.status === "pending") return null;

  serverLogger.warn(
    "⚠️ [PAYMENT-VERIFY] Payment already processed. Order ID:",
    existingOrder.orderId
  );

  // No invoice recovery any more: DMS issues no bills (owner decision,
  // 24 Sep 2026). The first /verify already flagged a paid order for an
  // operator to bill in ResellerOS; a duplicate call adds nothing.
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
