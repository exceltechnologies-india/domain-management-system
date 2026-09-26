import mongoose from "mongoose";
import Order from "@/models/Order";
import { createPaymentInTransaction } from "@/lib/services/payments";
import { serverLogger } from "@/lib/server-logger";
import {
  provisionCartItems,
  type OrderDomain,
  type RegistrationResult,
} from "@/lib/services/payment/provisioner";
import type { HydratedDocument } from "mongoose";
import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import type { CartItem, RazorpayPaymentDetails } from "@/lib/types";

/** What finalizePendingOrder returns. (Named for createCompletedOrder, deleted 26 Sep 2026 with its last caller.) */
export interface CreateCompletedOrderResult {
  order: HydratedDocument<IOrder>;
  orderId: string;
  /** Legacy `Order.paymentId` — optional after L10 dropped the required/unique constraint. */
  paymentId?: string;
  registrationTotalAmount: number;
  registrationResults: RegistrationResult[];
  orderDomains: OrderDomain[];
  finalSuccessfulDomains: string[];
  pendingDomains: OrderDomain[];
  failedDomains: OrderDomain[];
  orderStatus: "completed";
}

export interface FinalizePendingOrderInput {
  /** The order that was already claimed (pending → processing) by the caller. */
  order: HydratedDocument<IOrder>;
  user: IUser;
  razorpay_payment_id: string;
  razorpay_signature: string;
  razorpay_subscription_id?: string;
  paymentDetails: RazorpayPaymentDetails;
}

/**
 * Finalise an order that already exists in `processing` state — created at
 * /create-order time as `pending`, then claimed atomically by /verify or
 * /razorpay/webhook. Provisions the cart, writes the per-domain results
 * onto the existing document, and transitions it to `completed`.
 *
 * SECURITY: cartItems is derived from `order.domains` (pinned at
 * create-order time), NOT from the request body. The Razorpay signature
 * check only validates the order id + total — it doesn't bind the item
 * composition. Trusting request-body cartItems here would let a user who
 * paid for `cheap.in` swap it for `expensive.com`.
 *
 * Why .save() rather than updateOne(): the Order pre-save hook generates
 * `invoiceNumber` on the `completed` transition; that hook only fires on
 * doc.save(), not on direct updates.
 */
export async function finalizePendingOrder(
  input: FinalizePendingOrderInput
): Promise<CreateCompletedOrderResult> {
  const {
    order,
    user,
    razorpay_payment_id,
    razorpay_signature,
    razorpay_subscription_id,
    paymentDetails,
  } = input;

  const orderId = order.orderId;

  // Rebuild cartItems from the DB-pinned `order.domains` array. Each entry
  // was written at create-order time after the price-verifier passed, so
  // this is the trusted view of what the user actually paid for. `isTrial`
  // must round-trip: without it the hosting provisioner takes the paid
  // branch and the 1-trial-per-user gate is bypassed for bundle carts.
  const cartItems: CartItem[] = order.domains.map((d) => ({
    domainName: d.domainName,
    price: d.price,
    currency: d.currency,
    registrationPeriod: d.registrationPeriod,
    itemType: d.itemType,
    periodUnit: d.periodUnit as CartItem["periodUnit"],
    isTrial: d.isTrial === true,
    // Restore linkedDomain so the hosting provisioner targets the real
    // domain (e.g. "tryraju.com") rather than the synthetic cart-store ID
    // stored in d.domainName for hosting items.
    linkedDomain: (d as { linkedDomain?: string }).linkedDomain,
    hostingPlan: d.hostingPlan
      ? {
          id: d.hostingPlan.planId,
          name: d.hostingPlan.name,
          serverPackage: d.hostingPlan.serverPackage,
        }
      : undefined,
  }));

  serverLogger.info(
    `🚀 [PAYMENT-VERIFY] Finalising pending order ${orderId} — starting provisioning. status=${paymentDetails.status}`
  );

  const {
    registrationResults,
    orderDomains,
    finalSuccessfulDomains,
    pendingDomains,
    failedDomains,
  } = await provisionCartItems({
    cartItems,
    user,
    orderId,
    razorpay_payment_id,
    razorpay_subscription_id,
  });

  const paymentVerification = {
    verifiedAt: new Date(),
    paymentStatus: paymentDetails.status,
    paymentAmount: paymentDetails.amount,
    paymentCurrency: paymentDetails.currency,
    // `required: true` on the nested schema field, and Razorpay returns
    // `order_id: null` on a subscription/mandate payment — which would throw
    // out of the save() below, AFTER provisionCartItems has already created
    // the DirectAdmin account and Hosting row. `order.razorpayOrderId` is
    // always populated (create-order writes it before the customer reaches
    // Checkout), so it is the safe floor here.
    razorpayOrderId: paymentDetails.order_id || order.razorpayOrderId,
  };

  // Persist the post-provisioning view (registration results, ResellerClub
  // IDs, hosting plan metadata, payment metadata) on the Order BEFORE the
  // status-flip transaction. provisionCartItems already created Hosting docs
  // and registered domains in RC — if the subsequent save() throws (schema
  // validation, mongo blip), this updateOne ensures the Order at minimum
  // reflects what was actually provisioned. Without this the Order would
  // stay at status=processing with the placeholder domains[] from
  // /create-order and admin would have no way to reconcile the real
  // post-provisioning state without re-running the RC/DA side effects.
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        domains: orderDomains,
        successfulDomains: finalSuccessfulDomains,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        paymentVerification,
      },
    }
  );

  // Refresh the in-memory doc so save() emits only the status transition
  // (which fires the pre-save hook for invoiceNumber generation) plus the
  // Payment row, both inside the transaction.
  order.domains = orderDomains as unknown as IOrder["domains"];
  order.successfulDomains = finalSuccessfulDomains;
  order.razorpayPaymentId = razorpay_payment_id;
  order.razorpaySignature = razorpay_signature;
  order.paymentVerification = paymentVerification as IOrder["paymentVerification"];
  order.status = "completed";

  const registrationTotalAmount = cartItems.reduce(
    (total, item) => total + item.price * (item.registrationPeriod || 1),
    0
  );

  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      await order.save({ session: dbSession });
      await createPaymentInTransaction(
        {
          userId: user._id,
          orderId,
          razorpayPaymentId: razorpay_payment_id,
          amount: registrationTotalAmount,
          currency: paymentDetails.currency || "INR",
          status: "completed",
        },
        dbSession
      );
    });
  } catch (error) {
    serverLogger.error(
      `[PAYMENT-VERIFY] Order ${orderId} save/Payment transaction failed AFTER provisioning. Provisioning results are persisted on the Order via updateOne — admin should flip status manually.`,
      error
    );
    throw error;
  } finally {
    await dbSession.endSession();
  }

  serverLogger.info(
    `✅ [PAYMENT-VERIFY] Pending order finalised: ${orderId} PON=${order.purchaseOrderNumber}`
  );

  return {
    order,
    orderId,
    paymentId: order.paymentId,
    registrationTotalAmount,
    registrationResults,
    orderDomains,
    finalSuccessfulDomains,
    pendingDomains,
    failedDomains,
    orderStatus: "completed",
  };
}
