import { NextRequest, NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";
import { AuthService } from "@/lib/auth";
import {
  claimPendingOrderForProcessing,
  forceMarkZohoCreationFailed,
  getOrderByRazorpayOrderId,
} from "@/lib/services/orders";
import { handleRenewalPayment } from "@/lib/services/payment/renewal";
import { handleAlreadyProcessedPayment } from "@/lib/services/payment/idempotency";
import {
  createZohoInvoice,
  runPostPaymentTasks,
} from "@/lib/services/payment/post-tasks";
import {
  verifyRazorpayPayment,
  validateOrderAmountMatchesRazorpay,
} from "@/lib/services/payment/verification";
import {
  validateNoRestrictedDomains,
  createCompletedOrder,
  finalizePendingOrder,
  cartItemsFromOrderDomains,
} from "@/lib/services/payment/order-creator";
import { handleVerificationError } from "@/lib/services/payment/verification-error";
import { recordSystemLog } from "@/lib/services/system-logs";
import { withRequestLogContext } from "@/lib/request-context";
import type { IUser } from "@/models/User";
import type { CartItem } from "@/lib/types";
import { validatedBody, z } from "@/lib/api-validation";

// Cart-item shape is loose by design — every callsite already coerces to
// CartItem via `as CartItem`, and the downstream `validateNoRestrictedDomains`
// + price-verification flows narrow further. passthrough() keeps the
// underlying fields (linkedDomain, tldAttributes, etc.) flowing through
// unchanged.
const verifyCartItemSchema = z.object({
  domainName: z.string().min(1),
  price: z.number().nonnegative(),
  currency: z.string().min(1),
  registrationPeriod: z.number().int().positive().optional(),
  itemType: z.enum(["domain", "hosting"]).optional(),
}).passthrough();

// Payment verification: either an order_id (one-time charge) or a
// subscription_id (recurring) must be present, plus payment_id +
// signature. The refine encodes the order-XOR-subscription constraint
// at the schema layer instead of a post-destructure check.
const verifyPaymentSchema = z
  .object({
    razorpay_order_id: z.string().optional(),
    razorpay_subscription_id: z.string().optional(),
    razorpay_payment_id: z.string().min(1, "Payment verification data is required"),
    razorpay_signature: z.string().min(1, "Payment verification data is required"),
    cartItems: z.array(verifyCartItemSchema).min(1, "Cart items are required"),
  })
  .refine(
    (d) => Boolean(d.razorpay_order_id || d.razorpay_subscription_id),
    {
      message: "Payment verification data is required",
      path: ["razorpay_order_id"],
    }
  );

export const dynamic = "force-dynamic";

// withRequestLogContext binds the request ID from `x-request-id` (set by
// middleware) into AsyncLocalStorage for the duration of the handler. Every
// serverLogger.* call below — and inside the payment-services modules this
// handler invokes — automatically carries `requestId` in its structured-JSON
// output, with no per-call-site change needed.
export const POST = withRequestLogContext(async (request: NextRequest) => {
  let user: IUser | null = null;
  let cartItems: CartItem[] = [];
  // Hoisted so handleVerificationError below can update the right pending
  // Order instead of creating a duplicate fallback row.
  let razorpayOrderIdOuter: string | undefined;
  let razorpayPaymentIdOuter: string | undefined;
  let existingOrderRef: Awaited<ReturnType<typeof getOrderByRazorpayOrderId>> = null;

  try {
    user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, verifyPaymentSchema);
    if (!validation.ok) return validation.response;
    const {
      razorpay_order_id,
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature,
      cartItems: validatedCartItems,
    } = validation.data;
    cartItems = validatedCartItems as CartItem[];

    // Mirror to outer-scope refs so the catch handler can pass real
    // Razorpay identifiers + the existing pending Order to
    // handleVerificationError (so it updates the right row instead of
    // creating a duplicate fallback).
    razorpayOrderIdOuter = razorpay_order_id;
    razorpayPaymentIdOuter = razorpay_payment_id;

    // 1) Verify signature + status + order/subscription match
    const verifyResult = await verifyRazorpayPayment({
      razorpay_order_id,
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature,
    });
    if (!verifyResult.ok) return verifyResult.response;
    const { paymentDetails } = verifyResult;

    // 2) Early-exit for already-completed / in-progress orders by razorpay_order_id
    const existingOrder = razorpay_order_id
      ? await getOrderByRazorpayOrderId(razorpay_order_id)
      : null;
    existingOrderRef = existingOrder;

    // Defense-in-depth ownership check. The Razorpay signature is order-bound
    // so cross-account claim isn't directly exploitable today, but any future
    // change to the signature path would have nothing else stopping it.
    if (existingOrder && String(existingOrder.userId) !== String(user._id)) {
      serverLogger.warn(
        `[PAYMENT-VERIFY] User ${user._id} attempted to claim order ${existingOrder.orderId} owned by ${existingOrder.userId}`
      );
      return NextResponse.json(
        { error: "Order not found" },
        { status: 404 }
      );
    }

    if (existingOrder) {
      if (existingOrder.status === "completed") {
        return NextResponse.json({
          success: true,
          message: "Order already completed.",
          orderId: existingOrder.orderId,
        });
      }
      if (
        existingOrder.status === "paid" ||
        existingOrder.status === "processing"
      ) {
        return NextResponse.json({
          success: true,
          message: "Payment processed, provisioning in progress.",
          orderId: existingOrder.orderId,
          domainRegistrationStatus: "processing",
        });
      }
    }

    // 3) Amount-matches-DB check for pending orders (anti-underpayment fraud)
    if (razorpay_order_id && existingOrder && existingOrder.status === "pending") {
      const amountCheck = await validateOrderAmountMatchesRazorpay(
        razorpay_order_id,
        existingOrder
      );
      if (!amountCheck.ok) return amountCheck.response;
    }

    // 4) Renewal / invoice-payment flow (hosting reactivation)
    const renewalResponse = await handleRenewalPayment({
      razorpay_order_id: razorpay_order_id ?? "",
      razorpay_payment_id,
      razorpay_subscription_id,
      paymentDetails,
      user,
    });
    if (renewalResponse) return renewalResponse;

    // 5) Hosting upgrade flow (detected via DB orderType)
    if (existingOrder?.orderType === "hosting_upgrade") {
      const { handleUpgradePayment } = await import(
        "@/lib/services/payment/upgrade"
      );
      return await handleUpgradePayment(
        razorpay_order_id!,
        razorpay_payment_id,
        razorpay_signature
      );
    }

    // 6) Idempotency guard for already-processed new orders
    const idempotencyResponse = await handleAlreadyProcessedPayment({
      razorpay_order_id: razorpay_order_id ?? "",
      razorpay_payment_id,
      paymentDetails,
      user,
      existingOrder,
      cartItems,
    });
    if (idempotencyResponse) return idempotencyResponse;

    // 7) Reject restricted domains before provisioning
    const restrictedCheck = validateNoRestrictedDomains(cartItems);
    if (!restrictedCheck.ok) return restrictedCheck.response;

    // 8) Pending-order finalisation: the order was persisted at /create-order
    // time with status=pending. Atomically claim it so /verify and the
    // /razorpay/webhook can't both run provisioning. If we lost the claim,
    // the webhook is already handling it — return a "processing" response.
    // If no pending order exists (shouldn't happen — /create-order writes
    // one — but defensive for legacy flows), fall through to the legacy
    // createCompletedOrder path.
    let order;
    let orderId: string;
    let registrationResults;
    let finalSuccessfulDomains: string[];
    let pendingDomains;
    let failedDomains;
    let orderDomains;
    let orderStatus: "completed";

    if (existingOrder && existingOrder.status === "pending" && razorpay_order_id) {
      const claimed = await claimPendingOrderForProcessing(razorpay_order_id, {
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        paymentVerification: {
          verifiedAt: new Date(),
          paymentStatus: paymentDetails.status,
          paymentAmount: paymentDetails.amount,
          paymentCurrency: paymentDetails.currency,
          // Razorpay's payment-details payload can be null here; use the
          // request-body order id, which we've already required-checked.
          razorpayOrderId: paymentDetails.order_id ?? razorpay_order_id,
        },
      });
      if (!claimed) {
        // Webhook beat us to it. Return success with the order id we know.
        serverLogger.info(
          `[PAYMENT-VERIFY] Pending order ${existingOrder.orderId} already claimed by webhook — returning processing`
        );
        return NextResponse.json({
          success: true,
          message: "Payment processed, provisioning in progress.",
          orderId: existingOrder.orderId,
          domainRegistrationStatus: "processing",
        });
      }
      ({
        order,
        orderId,
        registrationResults,
        finalSuccessfulDomains,
        pendingDomains,
        failedDomains,
        orderDomains,
        orderStatus,
      } = await finalizePendingOrder({
        order: claimed,
        user,
        // cartItems intentionally NOT passed — finalizePendingOrder derives
        // them from `claimed.domains` (pinned at create-order time). The
        // Razorpay signature check doesn't bind item composition, so
        // trusting request-body cartItems here would let a user swap one
        // paid domain for another.
        razorpay_payment_id,
        razorpay_signature,
        razorpay_subscription_id,
        paymentDetails,
      }));
    } else {
      // Legacy / defensive path — no pending order found, build from scratch.
      ({
        order,
        orderId,
        registrationResults,
        finalSuccessfulDomains,
        pendingDomains,
        failedDomains,
        orderDomains,
        orderStatus,
      } = await createCompletedOrder({
        user,
        cartItems,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        razorpay_subscription_id,
        paymentDetails,
      }));
    }

    // 9) Zoho invoice (synchronous so failures surface to the caller)
    let invoiceCreationFailed = false;
    let invoiceCreationError: string | null = null;
    let finalInvoiceNumber = order.invoiceNumber;

    // Use DB-trusted projection of the persisted order (not the request body)
    // for Zoho line items. Batch 5a [H1] closed the swap-domain hole for
    // provisioning by deriving cartItems from order.domains inside
    // finalizePendingOrder; this closes the parallel gap for the invoice
    // path so the Zoho/GST record matches what was actually sold.
    const zohoCartItems = cartItemsFromOrderDomains(order.domains);

    try {
      const { invoiceNumber: zohoNum } = await createZohoInvoice({
        order,
        orderId,
        razorpay_payment_id,
        paymentDetails,
        user,
        cartItems: zohoCartItems,
      });
      if (zohoNum) finalInvoiceNumber = zohoNum;
    } catch (zohoError: unknown) {
      invoiceCreationFailed = true;
      invoiceCreationError = zohoError instanceof Error ? zohoError.message : "Unknown Zoho error";
      const stack = zohoError instanceof Error ? zohoError.stack : undefined;
      serverLogger.error(
        `❌ [PAYMENT-VERIFY] Zoho invoice creation failed: ${invoiceCreationError}`
      );
      // Durable record so we don't depend on Cloud Logging capturing stderr.
      await recordSystemLog({
        level: "error",
        message: `[PAYMENT-VERIFY] Zoho invoice failed after retries: ${invoiceCreationError}`,
        source: "payments/verify",
        service: "payments",
        stack,
        metadata: { orderId, userId: String(user._id), razorpayPaymentId: razorpay_payment_id },
      }).catch(() => {});
      try {
        await forceMarkZohoCreationFailed(String(order._id));
      } catch (_) {}
    }

    // 10) Non-critical post-payment tasks (admin email, domain booking emails)
    await runPostPaymentTasks({
      order,
      user,
      orderDomains,
      finalSuccessfulDomains,
      orderStatus,
    });

    const hasHosting = cartItems.some((item) => item.itemType === "hosting");
    const hasDomain = cartItems.some(
      (item) => item.itemType === "domain" || !item.itemType
    );

    return NextResponse.json(
      {
        success: true,
        message:
          finalSuccessfulDomains.length > 0
            ? hasHosting && hasDomain
              ? "Payment verified, services registered and provisioned successfully"
              : hasHosting
              ? "Payment verified and hosting provisioned successfully"
              : "Payment verified and domains registered successfully"
            : pendingDomains.length > 0
            ? hasHosting && hasDomain
              ? "Payment successful! Service registration and provisioning is being processed"
              : hasHosting
              ? "Payment successful! Hosting provisioning is being processed"
              : "Payment successful! Domain registration is being processed"
            : hasHosting && !hasDomain
            ? "Payment verified. Hosting provisioning encountered issues"
            : "Payment verified. Domain registration encountered issues",
        orderId,
        invoiceNumber: finalInvoiceNumber,
        invoiceStatus: invoiceCreationFailed ? "failed" : "created",
        ...(invoiceCreationFailed && {
          invoiceCreationError:
            "Invoice generation failed. Your payment was received and services are active. Please contact support to obtain your invoice.",
        }),
        registrationResults,
        successfulDomains: finalSuccessfulDomains,
        pendingDomains: pendingDomains.map((d) => d.domainName),
        failedDomains: failedDomains.map((d) => ({
          domainName: d.domainName,
          error: d.error,
        })),
        paymentStatus: "success",
        domainRegistrationStatus:
          finalSuccessfulDomains.length === cartItems.length
            ? "completed"
            : pendingDomains.length > 0
            ? "pending"
            : "partial",
      },
      { status: invoiceCreationFailed ? 207 : 200 }
    );
  } catch (error) {
    return handleVerificationError({
      error,
      user,
      cartItems,
      existingOrder: existingOrderRef,
      razorpay_order_id: razorpayOrderIdOuter,
      razorpay_payment_id: razorpayPaymentIdOuter,
    });
  }
});
