import { NextResponse } from "next/server";
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
import {
  isDomainSupported,
  requiresAdditionalDetails,
  getDomainRequirements,
} from "@/lib/domainRequirements";
import type { IUser } from "@/models/User";
import type { CartItem, RazorpayPaymentDetails } from "@/lib/types";

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@anutech.in";

/**
 * Project a persisted Order's `domains` subdocs to the `CartItem` shape
 * downstream consumers (Zoho invoice, post-payment tasks) expect. Returns
 * the DB-trusted view — pinned at /create-order time after the price
 * verifier passed — so callers can swap the request-body cartItems for
 * this without trusting client-supplied prices, names, or trial flags.
 *
 * Mirrors the projection in `finalizePendingOrder`'s rebuild block; kept
 * exported so /verify + /guest/verify can use it for the Zoho-invoice
 * step without re-deriving the shape inline.
 */
export function cartItemsFromOrderDomains(
  domains: IOrder["domains"]
): CartItem[] {
  return domains.map((d) => ({
    domainName: d.domainName,
    price: d.price,
    currency: d.currency,
    registrationPeriod: d.registrationPeriod,
    itemType: d.itemType,
    periodUnit: d.periodUnit as CartItem["periodUnit"],
    isTrial: d.isTrial === true,
    hostingPlan: d.hostingPlan
      ? {
          id: d.hostingPlan.planId,
          name: d.hostingPlan.name,
          serverPackage: d.hostingPlan.serverPackage,
        }
      : undefined,
  }));
}

/**
 * Reject orders containing domains that require manual verification or are
 * unsupported. Returns ok:false with a fully-formed 400 response if any
 * such domains are present.
 */
export function validateNoRestrictedDomains(
  cartItems: CartItem[]
): { ok: true } | { ok: false; response: NextResponse } {
  const restrictedDomains: Array<{ domainName: string; requirements: unknown }> = [];
  for (const item of cartItems) {
    if (
      requiresAdditionalDetails(item.domainName) ||
      !isDomainSupported(item.domainName)
    ) {
      restrictedDomains.push({
        domainName: item.domainName,
        requirements: getDomainRequirements(item.domainName),
      });
    }
  }

  if (restrictedDomains.length === 0) return { ok: true };

  serverLogger.error(
    `❌ [PAYMENT-VERIFY] Payment rejected — ${restrictedDomains.length} restricted domain(s) in cart`
  );
  return {
    ok: false,
    response: NextResponse.json(
      {
        success: false,
        error: "Payment rejected",
        message:
          "Some domains in your order require additional verification and cannot be processed automatically.",
        restrictedDomains: restrictedDomains.map((d) => ({
          domainName: d.domainName,
          reason: "Additional verification required",
        })),
        supportContact: `Please contact ${SUPPORT_EMAIL} for assistance with these domains.`,
      },
      { status: 400 }
    ),
  };
}

export interface CreateCompletedOrderInput {
  user: IUser;
  cartItems: CartItem[];
  razorpay_order_id?: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
  razorpay_subscription_id?: string;
  paymentDetails: RazorpayPaymentDetails;
}

export interface CreateCompletedOrderResult {
  order: HydratedDocument<IOrder>;
  orderId: string;
  paymentId: string;
  registrationTotalAmount: number;
  registrationResults: RegistrationResult[];
  orderDomains: OrderDomain[];
  finalSuccessfulDomains: string[];
  pendingDomains: OrderDomain[];
  failedDomains: OrderDomain[];
  orderStatus: "completed";
}

/**
 * Creates a new Order + Payment pair atomically after successful payment
 * verification. Generates IDs, infers the order type, provisions cart items,
 * and persists everything in one Mongo transaction.
 *
 * Caller is responsible for:
 *   - Auth + input validation
 *   - Calling validateNoRestrictedDomains() first
 *   - Idempotency / existing-order handling
 *   - Building the user-facing success response
 *   - Triggering Zoho + post-payment tasks afterwards
 */
export async function createCompletedOrder(
  input: CreateCompletedOrderInput
): Promise<CreateCompletedOrderResult> {
  const {
    user,
    cartItems,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    razorpay_subscription_id,
    paymentDetails,
  } = input;

  const orderId = `ord_${Date.now()}_${Math.random()
    .toString(36)
    .substring(2, 8)}`;
  const paymentId = `pay_${Date.now()}_${Math.random()
    .toString(36)
    .substring(2, 8)}`;

  const registrationTotalAmount = cartItems.reduce(
    (total, item) => total + item.price * (item.registrationPeriod || 1),
    0
  );

  const pendingPaymentData = paymentDetails
    ? {
        userId: user._id,
        orderId,
        razorpayPaymentId: razorpay_payment_id,
        amount: registrationTotalAmount,
        currency: paymentDetails.currency || "INR",
        status: "completed" as const,
      }
    : null;

  serverLogger.info(
    `🚀 [PAYMENT-VERIFY] Payment confirmed — starting provisioning. status=${paymentDetails.status}`
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

  const orderStatus = "completed" as const;

  const _hasDomains = cartItems.some(
    (i: CartItem) => !i.itemType || i.itemType === "domain"
  );
  const _hasHosting = cartItems.some((i: CartItem) => i.itemType === "hosting");
  const _hasTrial = cartItems.some(
    (i: CartItem) =>
      i.itemType === "hosting" &&
      (i as CartItem & { isTrial?: boolean }).isTrial === true
  );
  const derivedOrderType:
    | "domain"
    | "hosting"
    | "bundle"
    | "hosting_trial"
    | "unknown" = _hasTrial
    ? "hosting_trial"
    : _hasDomains && _hasHosting
    ? "bundle"
    : _hasDomains
    ? "domain"
    : _hasHosting
    ? "hosting"
    : "unknown";

  const inferredFromPrefix =
    !_hasTrial &&
    (orderId.startsWith("ord_dh")
      ? "bundle"
      : orderId.startsWith("ord_d")
      ? "domain"
      : orderId.startsWith("ord_h")
      ? "hosting"
      : null);

  const finalOrderType = inferredFromPrefix || derivedOrderType;
  serverLogger.info(
    `🏷️  [PAYMENT-VERIFY] Order type resolved: ${finalOrderType}`
  );

  const order = new Order({
    orderId,
    userId: user._id,
    userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
    userEmail: user.email,
    paymentId,
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    razorpaySignature: razorpay_signature,
    amount: registrationTotalAmount,
    currency: "INR",
    status: orderStatus,
    domains: orderDomains,
    successfulDomains: finalSuccessfulDomains,
    orderType: finalOrderType,
    paymentVerification: {
      verifiedAt: new Date(),
      paymentStatus: paymentDetails.status,
      paymentAmount: paymentDetails.amount,
      paymentCurrency: paymentDetails.currency,
      razorpayOrderId: paymentDetails.order_id,
    },
  });

  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      await order.save({ session: dbSession });
      if (pendingPaymentData) {
        await createPaymentInTransaction(pendingPaymentData, dbSession);
      }
    });
  } finally {
    await dbSession.endSession();
  }
  serverLogger.info(
    `✅ [PAYMENT-VERIFY] Order + Payment saved atomically [type=${finalOrderType}] PON=${order.purchaseOrderNumber}`
  );

  return {
    order,
    orderId,
    paymentId,
    registrationTotalAmount,
    registrationResults,
    orderDomains,
    finalSuccessfulDomains,
    pendingDomains,
    failedDomains,
    orderStatus,
  };
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
 * onto the existing document, and transitions it to `completed`. Mirrors
 * {@link createCompletedOrder}'s return shape so the calling route can
 * keep the same downstream code (Zoho invoice, post-payment tasks).
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
    razorpayOrderId: paymentDetails.order_id,
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
