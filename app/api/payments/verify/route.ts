import { NextRequest, NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import connectDB from "@/lib/mongodb";
import mongoose from "mongoose";
import Order from "@/models/Order";
import Payment from "@/models/Payment";
import {
  isDomainSupported,
  requiresAdditionalDetails,
  getDomainRequirements,
} from "@/lib/domainRequirements";
import { handleRenewalPayment } from "@/lib/payment-services/renewal";
import { handleAlreadyProcessedPayment } from "@/lib/payment-services/idempotency";
import { provisionCartItems } from "@/lib/payment-services/provisioner";
import {
  createZohoInvoice,
  runPostPaymentTasks,
} from "@/lib/payment-services/post-tasks";
import type { IUser } from "@/models/User";
import type { CartItem, RazorpayPaymentDetails } from "@/lib/types";

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@anutech.in";

export const dynamic = "force-dynamic";

// Show only the last 6 chars of Razorpay IDs in logs to prevent Cloud Logging exposure
const tid = (id?: string | null) => (id ? `...${id.slice(-6)}` : "none");

export async function POST(request: NextRequest) {
  let user: IUser | null = null;
  let cartItems: CartItem[] = [];

  try {
    user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      razorpay_order_id,
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature,
    } = body;
    cartItems = body.cartItems;

    if (
      (!razorpay_order_id && !razorpay_subscription_id) ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return NextResponse.json(
        { error: "Payment verification data is required" },
        { status: 400 }
      );
    }

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return NextResponse.json(
        { error: "Cart items are required" },
        { status: 400 }
      );
    }

    // Verify Razorpay payment signature
    const isPaymentValid = RazorpayService.verifyPayment({
      razorpay_order_id,
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (!isPaymentValid) {
      serverLogger.error(`❌ [PAYMENT-VERIFY] Invalid payment signature for order=${tid(razorpay_order_id)} sub=${tid(razorpay_subscription_id)} pay=${tid(razorpay_payment_id)}`);
      return NextResponse.json(
        { error: "Invalid payment signature" },
        { status: 400 }
      );
    }

    // Fetch payment details from Razorpay to confirm status and amount
    let paymentDetails: RazorpayPaymentDetails;
    try {
      paymentDetails = await RazorpayService.getPaymentDetails(
        razorpay_payment_id
      );
      serverLogger.info(`✅ [PAYMENT-VERIFY] Payment details fetched: pay=${tid(paymentDetails.id)} status=${paymentDetails.status} amount=${paymentDetails.amount} order=${tid(paymentDetails.order_id)} sub=${tid(paymentDetails.subscription_id)}`);
    } catch (error) {
      serverLogger.error("❌ [PAYMENT-VERIFY] Failed to fetch payment details", error);
      return NextResponse.json(
        { error: "Failed to verify payment status" },
        { status: 400 }
      );
    }

    if (!["captured", "authorized"].includes(paymentDetails.status)) {
      serverLogger.error(`❌ [PAYMENT-VERIFY] Invalid payment status: ${paymentDetails.status} isSubOnly=${!!razorpay_subscription_id && !razorpay_order_id}`);
      return NextResponse.json(
        {
          error: `Payment status is ${paymentDetails.status}. Verification failed for this amount/type.`,
        },
        { status: 400 }
      );
    }

    await connectDB();

    if (
      razorpay_order_id &&
      paymentDetails.order_id !== razorpay_order_id
    ) {
      serverLogger.error(
        `❌ [PAYMENT-VERIFY] Order ID mismatch. Expected: ${razorpay_order_id}, Received: ${paymentDetails.order_id}`
      );
      return NextResponse.json(
        { error: "Order ID mismatch" },
        { status: 400 }
      );
    }

    if (
      razorpay_subscription_id &&
      paymentDetails.subscription_id &&
      paymentDetails.subscription_id !== razorpay_subscription_id
    ) {
      serverLogger.error(
        `❌ [PAYMENT-VERIFY] Subscription ID mismatch. Expected: ${razorpay_subscription_id}, Received: ${paymentDetails.subscription_id}`
      );
      return NextResponse.json(
        { error: "Subscription ID mismatch" },
        { status: 400 }
      );
    }

    if (razorpay_subscription_id && !paymentDetails.subscription_id) {
      serverLogger.warn(`⚠️ [PAYMENT-VERIFY] sub=${tid(razorpay_subscription_id)} not in payment details but signature valid — proceeding`);
    }

    serverLogger.info(
      "✅ [PAYMENT-VERIFY] Payment verification successful. Proceeding with registration..."
    );

    await connectDB();

    // Check for existing order by Razorpay order ID — allows early-exit for already-completed orders
    const existingOrder = await Order.findOne({
      razorpayOrderId: razorpay_order_id,
    });

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

    // F3: Validate payment amount against DB order to prevent underpayment fraud
    if (razorpay_order_id && existingOrder && existingOrder.status === "pending") {
      try {
        const rzpOrder = await RazorpayService.getOrderDetails(
          razorpay_order_id
        );
        const expectedPaise = Math.round(existingOrder.amount * 100);
        if (Number(rzpOrder.amount) !== expectedPaise) {
          serverLogger.error(
            `❌ [PAYMENT-VERIFY] Amount mismatch. DB order expects ${expectedPaise} paise, Razorpay order has ${rzpOrder.amount} paise`
          );
          return NextResponse.json(
            { error: "Payment amount does not match order" },
            { status: 400 }
          );
        }
      } catch (err: any) {
        serverLogger.error(
          `❌ [PAYMENT-VERIFY] Failed to fetch Razorpay order for amount check:`,
          err.message
        );
        return NextResponse.json(
          { error: "Could not verify payment amount" },
          { status: 400 }
        );
      }
    }

    // Renewal / invoice-payment flow (hosting reactivation)
    const renewalResponse = await handleRenewalPayment({
      razorpay_order_id: razorpay_order_id ?? "",
      razorpay_payment_id,
      razorpay_subscription_id,
      paymentDetails,
      user,
    });
    if (renewalResponse) return renewalResponse;

    // Hosting upgrade flow — detected via DB orderType, not the receipt prefix,
    // because razorpay_order_id from the client is Razorpay's "order_XXXXX" ID.
    if (existingOrder?.orderType === "hosting_upgrade") {
      const { handleUpgradePayment } = await import("@/lib/payment-services/upgrade");
      return await handleUpgradePayment(razorpay_order_id!, razorpay_payment_id, razorpay_signature);
    }

    // Idempotency guard — returns response if this payment was already processed
    const idempotencyResponse = await handleAlreadyProcessedPayment({
      razorpay_order_id,
      razorpay_payment_id,
      paymentDetails,
      user,
      existingOrder,
      cartItems,
    });
    if (idempotencyResponse) return idempotencyResponse;

    // New order flow

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

    // Hold payment data for atomic write with the Order (see transaction below)
    const pendingPaymentData = paymentDetails
      ? {
          userId: user._id,
          orderId: orderId,
          razorpayPaymentId: razorpay_payment_id,
          amount: registrationTotalAmount,
          currency: paymentDetails.currency || "INR",
          status: "completed",
        }
      : null;

    serverLogger.info(`🚀 [PAYMENT-VERIFY] Payment confirmed — starting provisioning. status=${paymentDetails.status}`);

    // Reject orders with domains that require manual verification
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

    if (restrictedDomains.length > 0) {
      serverLogger.error(`❌ [PAYMENT-VERIFY] Payment rejected — ${restrictedDomains.length} restricted domain(s) in cart`);
      return NextResponse.json(
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
      );
    }

    // Provision hosting accounts and register domains
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

    const orderStatus = "completed";

    const _hasDomains = cartItems.some(
      (i: CartItem) => !i.itemType || i.itemType === "domain"
    );
    const _hasHosting = cartItems.some(
      (i: CartItem) => i.itemType === "hosting"
    );
    const _hasTrial = cartItems.some(
      (i: CartItem) => i.itemType === "hosting" && (i as any).isTrial === true
    );
    const derivedOrderType: "domain" | "hosting" | "bundle" | "hosting_trial" | "unknown" =
      _hasTrial
        ? "hosting_trial"
        : _hasDomains && _hasHosting
        ? "bundle"
        : _hasDomains
        ? "domain"
        : _hasHosting
        ? "hosting"
        : "unknown";

    const inferredFromPrefix = !_hasTrial && (
      orderId.startsWith("ord_dh")
        ? "bundle"
        : orderId.startsWith("ord_d")
        ? "domain"
        : orderId.startsWith("ord_h")
        ? "hosting"
        : null
    );

    const finalOrderType = inferredFromPrefix || derivedOrderType;
    serverLogger.info(`🏷️  [PAYMENT-VERIFY] Order type resolved: ${finalOrderType}`);

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

    // Atomically save Order + Payment so neither exists without the other
    const dbSession = await mongoose.startSession();
    try {
      await dbSession.withTransaction(async () => {
        await order.save({ session: dbSession });
        if (pendingPaymentData) {
          await Payment.create([pendingPaymentData], { session: dbSession });
        }
      });
    } finally {
      await dbSession.endSession();
    }
    serverLogger.info(`✅ [PAYMENT-VERIFY] Order + Payment saved atomically [type=${finalOrderType}] PON=${order.purchaseOrderNumber}`);

    // --- Zoho Books invoice — synchronous so failures are surfaced to the caller ---
    let invoiceCreationFailed = false;
    let invoiceCreationError: string | null = null;
    let finalInvoiceNumber = order.invoiceNumber;

    try {
      const { invoiceNumber: zohoNum } = await createZohoInvoice({
        order,
        orderId,
        razorpay_payment_id,
        paymentDetails,
        user,
        cartItems,
      });
      if (zohoNum) finalInvoiceNumber = zohoNum;
    } catch (zohoError: any) {
      invoiceCreationFailed = true;
      invoiceCreationError = zohoError?.message ?? "Unknown Zoho error";
      serverLogger.error(`❌ [PAYMENT-VERIFY] Zoho invoice creation failed: ${invoiceCreationError}`);
      // Mark the order so admins and the idempotency-recovery path can see it
      try {
        await Order.updateOne(
          { _id: order._id },
          { $set: { zohoInvoiceId: "creation_failed" } }
        );
      } catch (_) {}
    }

    // Non-critical tasks: admin email + domain booking email
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
    serverLogger.error("❌ [PAYMENT-VERIFY] Critical error in payment verification", error);

    const isPaymentError =
      error instanceof Error &&
      (error.message.includes("Invalid payment signature") ||
        error.message.includes("Payment not captured") ||
        error.message.includes("Payment amount mismatch") ||
        error.message.includes("Order ID mismatch"));

    if (!isPaymentError) {
      serverLogger.warn("⚠️ [PAYMENT-VERIFY] Payment verified but provisioning encountered errors — attempting fallback order");

      try {
        if (!user || !user._id) {
          serverLogger.error("❌ [PAYMENT-VERIFY] Cannot create fallback order — user not available");
          throw error;
        }

        await connectDB();

        const fallbackOrderId = `ord_${Date.now()}_${Math.random()
          .toString(36)
          .substring(2, 8)}`;

        const totalAmount = cartItems.reduce(
          (sum, item) => sum + (item.price || 0) * (item.registrationPeriod || 1),
          0
        );

        const fallbackOrder = new Order({
          orderId: fallbackOrderId,
          userId: user._id,
          paymentId: `pay_${Date.now()}_${Math.random()
            .toString(36)
            .substring(2, 8)}`,
          razorpayOrderId: "fallback_order",
          razorpayPaymentId: "fallback_payment",
          razorpaySignature: "fallback_signature",
          amount: totalAmount,
          currency: "INR",
          status: "completed",
          domains: cartItems.map((item) => ({
            domainName: item.domainName,
            price: item.price,
            currency: item.currency || "INR",
            registrationPeriod: item.registrationPeriod || 1,
            periodUnit:
              item.periodUnit ||
              (item.itemType === "hosting" ? "months" : "years"),
            status: "pending",
            bookingStatus: [
              {
                step: "payment_verified",
                message:
                  "Payment verified - Domain registration pending due to system error",
                timestamp: new Date(),
                progress: 30,
              },
            ],
            error: "Domain registration pending - Please contact support",
          })),
          successfulDomains: [],
          paymentVerification: {
            verifiedAt: new Date(),
            paymentStatus: "completed",
            paymentAmount: totalAmount,
            paymentCurrency: "INR",
            razorpayOrderId: "fallback_order",
          },
        });

        await fallbackOrder.save();
        serverLogger.info(`✅ [PAYMENT-VERIFY] Fallback order saved PON=${fallbackOrder.purchaseOrderNumber}`);

        const hasHostingFallback = cartItems.some(
          (item) => item.itemType === "hosting"
        );
        const hasDomainFallback = cartItems.some(
          (item) => item.itemType === "domain" || !item.itemType
        );

        return NextResponse.json({
          success: true,
          message:
            hasHostingFallback && hasDomainFallback
              ? "Payment successful! Service registration and provisioning is being processed."
              : hasHostingFallback
              ? "Payment successful! Hosting provisioning is being processed."
              : "Payment successful! Domain registration is being processed.",
          orderId: fallbackOrder.orderId,
          invoiceNumber: fallbackOrder.invoiceNumber,
          registrationResults: cartItems.map((item) => ({
            domainName: item.domainName,
            status: "pending",
            error: "Registration pending",
          })),
          successfulDomains: [],
          pendingDomains: cartItems.map((item) => item.domainName),
          paymentStatus: "success",
          domainRegistrationStatus: "pending",
          requiresSupport: true,
        });
      } catch (fallbackError) {
        serverLogger.error("❌ [PAYMENT-VERIFY] Failed to create fallback order", fallbackError);
      }
    }

    let errorMessage = "Payment verification failed";
    let statusCode = 500;
    let errorType = "verification_error";

    if (error instanceof Error) {
      if (error.message.includes("Invalid payment signature")) {
        errorMessage =
          "Payment signature verification failed. Please try again.";
        statusCode = 400;
        errorType = "signature_error";
      } else if (error.message.includes("Payment not found")) {
        errorMessage =
          "Payment not found. Please contact support if you were charged.";
        statusCode = 404;
        errorType = "payment_not_found";
      } else if (error.message.includes("Payment already processed")) {
        errorMessage = "This payment has already been processed.";
        statusCode = 409;
        errorType = "duplicate_payment";
      } else if (error.message.includes("Payment not captured")) {
        errorMessage =
          "Payment was not captured successfully. Please try again.";
        statusCode = 402;
        errorType = "payment_not_captured";
      } else if (error.message.includes("Payment amount mismatch")) {
        errorMessage =
          "Payment amount verification failed. Please contact support.";
        statusCode = 400;
        errorType = "amount_mismatch";
      } else if (error.message.includes("Card declined")) {
        errorMessage =
          "Your card was declined. Please try a different payment method.";
        statusCode = 402;
        errorType = "card_declined";
      } else if (
        error.message.includes("Network error") ||
        error.message.includes("timeout")
      ) {
        errorMessage =
          "Network error occurred. Please check your payment status in a few minutes.";
        statusCode = 503;
        errorType = "network_error";
      } else {
        errorMessage = `Payment verification encountered an error: ${error.message}`;
        serverLogger.error(
          "❌ [PAYMENT-VERIFY] Unhandled error type:",
          error.message,
          error
        );
      }
    }

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        errorType: errorType,
        message:
          "Payment verification failed. Please contact support if the issue persists.",
        supportContact: SUPPORT_EMAIL,
      },
      { status: statusCode }
    );
  }
}
