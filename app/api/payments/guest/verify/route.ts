import { NextRequest, NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";
import { RazorpayService } from "@/lib/razorpay";
import { verifyGuestToken } from "@/lib/guest-token";
import connectDB from "@/lib/mongodb";
import mongoose from "mongoose";
import type { IUser } from "@/models/User";
import { createUser, getUserByEmail } from "@/lib/services/users";
import Order from "@/models/Order";
import { claimPendingOrderForProcessing, createOrder, createOrderInSession, forceMarkZohoCreationFailed, getOrderByRazorpayOrderId } from "@/lib/services/orders";
import { createPaymentInTransaction } from "@/lib/services/payments";
import { provisionCartItems } from "@/lib/services/payment/provisioner";
import { finalizePendingOrder } from "@/lib/services/payment/order-creator";
import { createZohoInvoice, runPostPaymentTasks } from "@/lib/services/payment/post-tasks";
import { recordSystemLog } from "@/lib/services/system-logs";
import { isDomainSupported, requiresAdditionalDetails } from "@/lib/domainRequirements";
import { EmailService } from "@/lib/email";
import type { CartItem, RazorpayPaymentDetails } from "@/lib/types";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@anutech.in";

export async function POST(request: NextRequest) {
  // Hoisted so catch block can create a fallback Order if provisioning fails
  // after payment has already been verified
  let guestUser: IUser | null | undefined;
  let orderId: string | undefined;
  let cartItems: CartItem[] = [];
  let guestEmail = "";
  let razorpay_order_id = "";
  let razorpay_payment_id = "";
  let razorpay_signature = "";

  try {
    const body = await request.json();
    const parsed: {
      guestToken: string;
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
      cartItems: CartItem[];
    } = body;
    razorpay_order_id = parsed.razorpay_order_id;
    razorpay_payment_id = parsed.razorpay_payment_id;
    razorpay_signature = parsed.razorpay_signature;
    cartItems = parsed.cartItems;
    const guestToken = parsed.guestToken;

    // ── Validate guest token ─────────────────────────────────────────────────
    if (!guestToken) {
      return NextResponse.json({ error: "Guest token required" }, { status: 401 });
    }
    const tokenPayload = verifyGuestToken(guestToken);
    if (!tokenPayload) {
      return NextResponse.json(
        { error: "Guest session expired — please start checkout again" },
        { status: 401 }
      );
    }
    guestEmail = tokenPayload.email;

    // ── Validate payment fields ──────────────────────────────────────────────
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return NextResponse.json(
        { error: "Payment verification data is required" },
        { status: 400 }
      );
    }

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return NextResponse.json({ error: "Cart items required" }, { status: 400 });
    }

    // Trials still require a login (1-per-user-lifetime eligibility); paid
    // hosting + domains are fine for guest checkout.
    if (cartItems.some((i: CartItem) => i.isTrial === true)) {
      return NextResponse.json(
        { error: "Free trials require an account. Please sign in." },
        { status: 400 }
      );
    }

    // ── Verify Razorpay signature ────────────────────────────────────────────
    const isValid = RazorpayService.verifyPayment({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (!isValid) {
      serverLogger.error(
        `[GuestCheckout] Invalid signature for order=${razorpay_order_id}`
      );
      return NextResponse.json({ error: "Invalid payment signature" }, { status: 400 });
    }

    // ── Fetch payment details from Razorpay ──────────────────────────────────
    let paymentDetails: RazorpayPaymentDetails;
    try {
      paymentDetails = await RazorpayService.getPaymentDetails(razorpay_payment_id);
    } catch {
      return NextResponse.json(
        { error: "Failed to verify payment status" },
        { status: 400 }
      );
    }

    if (!["captured", "authorized"].includes(paymentDetails.status)) {
      return NextResponse.json(
        { error: `Payment status is ${paymentDetails.status}` },
        { status: 400 }
      );
    }

    if (paymentDetails.order_id !== razorpay_order_id) {
      return NextResponse.json({ error: "Order ID mismatch" }, { status: 400 });
    }

    // ── Idempotency guard ────────────────────────────────────────────────────
    const existingOrder = await getOrderByRazorpayOrderId(razorpay_order_id);
    if (existingOrder?.status === "completed") {
      return NextResponse.json({
        success: true,
        message: "Order already completed",
        orderId: existingOrder.orderId,
        guestEmail,
        isGuest: true,
      });
    }
    // The webhook is already running provisioning — don't double-process.
    if (
      existingOrder?.status === "processing" ||
      existingOrder?.status === "paid"
    ) {
      return NextResponse.json({
        success: true,
        message: "Payment processed, provisioning in progress.",
        orderId: existingOrder.orderId,
        guestEmail,
        isGuest: true,
        domainRegistrationStatus: "processing",
      });
    }

    // ── Validate domains ─────────────────────────────────────────────────────
    // Hosting items skip this — they don't go through RC at all.
    for (const item of cartItems) {
      if (item.itemType === "hosting") continue;
      if (requiresAdditionalDetails(item.domainName) || !isDomainSupported(item.domainName)) {
        return NextResponse.json(
          {
            error: "Some domains require additional verification. Please contact " + SUPPORT_EMAIL,
          },
          { status: 400 }
        );
      }
    }

    // ── Find or create guest user ────────────────────────────────────────────
    // Registrant details come from the signed guest token (collected up-front
    // in /checkout/guest before payment) — these are what ResellerClub will
    // see on the WHOIS contact, so they must be real, not dummy values.
    guestUser = await getUserByEmail(guestEmail);
    if (!guestUser) {
      guestUser = await createUser({
        email: guestEmail,
        password: randomBytes(32).toString("hex"), // unusable random password
        firstName: tokenPayload.firstName,
        lastName: tokenPayload.lastName,
        phone: tokenPayload.phone,
        phoneCc: "+91",
        address: {
          line1: tokenPayload.addressLine1,
          city: tokenPayload.city,
          state: tokenPayload.state,
          country: "IN",
          zipcode: tokenPayload.zipcode,
        },
        role: "user",
        isActive: true,
        isActivated: true,
        isGuest: true,
        profileCompleted: true,
        provider: "credentials",
      });
      serverLogger.info(`[GuestCheckout] Created guest user: ${guestEmail}`);
    } else if (guestUser.isGuest && !guestUser.profileCompleted) {
      // Same email used again before profile completed — backfill from token.
      guestUser.firstName = guestUser.firstName || tokenPayload.firstName;
      guestUser.lastName = guestUser.lastName || tokenPayload.lastName;
      guestUser.phone = guestUser.phone || tokenPayload.phone;
      guestUser.phoneCc = guestUser.phoneCc || "+91";
      guestUser.address = {
        line1: guestUser.address?.line1 || tokenPayload.addressLine1,
        city: guestUser.address?.city || tokenPayload.city,
        state: guestUser.address?.state || tokenPayload.state,
        country: "IN",
        zipcode: guestUser.address?.zipcode || tokenPayload.zipcode,
      };
      guestUser.profileCompleted = true;
      await guestUser.save();
      serverLogger.info(`[GuestCheckout] Back-filled details for guest: ${guestEmail}`);
    } else if (!guestUser.isGuest) {
      // Existing registered user — respect their saved profile, ignore form values.
      serverLogger.info(`[GuestCheckout] Existing user ${guestEmail} — using their saved profile`);
    }

    // ── Claim the pending order and provision ────────────────────────────────
    // The order was persisted at /create-order time with status=pending.
    // Atomically claim it (pending → processing) so /verify and the
    // /razorpay/webhook can't both run provisioning. If we lost the claim,
    // the webhook is already handling it — return success and let the user
    // re-fetch when provisioning completes.
    let order!: Awaited<ReturnType<typeof createOrderInSession>>;
    let finalSuccessfulDomains: string[] = [];
    let orderDomains: Awaited<ReturnType<typeof provisionCartItems>>["orderDomains"] = [];

    if (existingOrder && existingOrder.status === "pending") {
      const claimed = await claimPendingOrderForProcessing(razorpay_order_id, {
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        paymentVerification: {
          verifiedAt: new Date(),
          paymentStatus: paymentDetails.status,
          paymentAmount: paymentDetails.amount,
          paymentCurrency: paymentDetails.currency,
          razorpayOrderId: paymentDetails.order_id ?? razorpay_order_id,
        },
      });
      if (!claimed) {
        serverLogger.info(
          `[GuestCheckout] Pending order ${existingOrder.orderId} already claimed by webhook — returning processing`
        );
        return NextResponse.json({
          success: true,
          message: "Payment processed, provisioning in progress.",
          orderId: existingOrder.orderId,
          guestEmail,
          isGuest: true,
          domainRegistrationStatus: "processing",
        });
      }
      const finalised = await finalizePendingOrder({
        order: claimed,
        user: guestUser,
        cartItems,
        razorpay_payment_id,
        razorpay_signature,
        paymentDetails,
      });
      order = finalised.order;
      orderId = finalised.orderId;
      orderDomains = finalised.orderDomains;
      finalSuccessfulDomains = finalised.finalSuccessfulDomains;
    } else {
      // Legacy / defensive path — pending order wasn't found (shouldn't
      // happen now that /create-order writes one). Build the order from
      // scratch the way the pre-refactor flow did.
      orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      const provisioned = await provisionCartItems({
        cartItems,
        user: guestUser,
        orderId,
        razorpay_payment_id,
      });
      orderDomains = provisioned.orderDomains;
      finalSuccessfulDomains = provisioned.finalSuccessfulDomains;

      const registrationTotalAmount = cartItems.reduce(
        (sum, item) => sum + item.price * (item.registrationPeriod || 1),
        0
      );

      const hasDomainItem = cartItems.some(
        (i) => !i.itemType || i.itemType === "domain"
      );
      const hasHostingItem = cartItems.some((i) => i.itemType === "hosting");
      const derivedOrderType: "domain" | "hosting" | "bundle" =
        hasDomainItem && hasHostingItem
          ? "bundle"
          : hasHostingItem
          ? "hosting"
          : "domain";

      const orderPayload = {
        orderId,
        userId: guestUser._id,
        userName: `${guestUser.firstName || ""} ${guestUser.lastName || ""}`.trim(),
        userEmail: guestEmail,
        paymentId: `pay_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        amount: registrationTotalAmount,
        currency: "INR",
        status: "completed",
        domains: orderDomains,
        successfulDomains: finalSuccessfulDomains,
        orderType: derivedOrderType,
        paymentVerification: {
          verifiedAt: new Date(),
          paymentStatus: paymentDetails.status,
          paymentAmount: paymentDetails.amount,
          paymentCurrency: paymentDetails.currency,
          razorpayOrderId: paymentDetails.order_id,
        },
      };

      const dbSession = await mongoose.startSession();
      try {
        await dbSession.withTransaction(async () => {
          order = await createOrderInSession(orderPayload, dbSession);
          await createPaymentInTransaction(
            {
              userId: guestUser!._id,
              orderId: orderId!,
              razorpayPaymentId: razorpay_payment_id,
              amount: registrationTotalAmount,
              currency: paymentDetails.currency || "INR",
              status: "completed",
            },
            dbSession
          );
        });
      } finally {
        await dbSession.endSession();
      }
    }

    // ── Zoho invoice (best-effort) ───────────────────────────────────────────
    // createZohoInvoice retries internally (2 attempts, 1.5s gap) so transient
    // cold-start / token-refresh races don't leave the order stuck. Only on
    // final failure do we mark creation_failed and rely on the background
    // self-heal in /api/user/invoices.
    try {
      await createZohoInvoice({
        order,
        orderId,
        razorpay_payment_id,
        paymentDetails,
        user: guestUser,
        cartItems,
      });
    } catch (zohoErr: unknown) {
      const message = zohoErr instanceof Error ? zohoErr.message : String(zohoErr);
      const stack = zohoErr instanceof Error ? zohoErr.stack : undefined;
      serverLogger.error(`[GuestCheckout] Zoho invoice failed: ${message}`);
      // Durable record so we don't depend on Cloud Logging capturing stderr.
      await recordSystemLog({
        level: "error",
        message: `[GuestCheckout] Zoho invoice failed after retries: ${message}`,
        source: "guest/verify",
        service: "payments",
        stack,
        metadata: { orderId, email: guestEmail, razorpayPaymentId: razorpay_payment_id },
      }).catch(() => {});
      await forceMarkZohoCreationFailed(String(order._id)).catch(() => {});
    }

    // ── Post-payment notifications ────────────────────────────────────────────
    await runPostPaymentTasks({
      order,
      user: guestUser,
      orderDomains,
      finalSuccessfulDomains,
      orderStatus: "completed",
    });

    serverLogger.info(
      `[GuestCheckout] Order complete: ${orderId} for ${guestEmail} — ${finalSuccessfulDomains.length} domains`
    );

    // ── Proactively send a "Set Password" email for new guest accounts ──
    // The payment-success page also surfaces a button, but if the user
    // closes that page they'd have no way back to set their password.
    // Mailing the link gives them a permanent path to activate the account.
    // Only fires when the user is still in guest state (no password yet)
    // — repeat guests using the flow on the same account won't get a
    // duplicate email.
    if (guestUser.isGuest === true) {
      try {
        const token = randomBytes(32).toString("hex");
        guestUser.resetToken = token;
        guestUser.resetTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h for setup
        await guestUser.save();
        const name = `${guestUser.firstName || ""} ${guestUser.lastName || ""}`.trim() || "there";
        EmailService.sendPasswordResetEmail(guestUser.email, name, token, true)
          .then((ok) => {
            if (ok) {
              serverLogger.info(`[GuestCheckout] Setup email sent to ${guestUser!.email}`);
            } else {
              serverLogger.warn(`[GuestCheckout] Setup email send returned false for ${guestUser!.email}`);
            }
          })
          .catch((err) => {
            serverLogger.error(`[GuestCheckout] Setup email failed for ${guestUser!.email}:`, err);
          });
      } catch (err) {
        // Non-fatal: order is already provisioned, user can still use the
        // payment-success page button or hit /reset-password manually.
        serverLogger.error("[GuestCheckout] Failed to prepare setup email:", err);
      }
    }

    return NextResponse.json({
      success: true,
      message:
        finalSuccessfulDomains.length > 0
          ? "Payment verified and domain registration initiated"
          : "Payment verified — domain registration pending manual review",
      orderId,
      guestEmail,
      isGuest: guestUser.isGuest ?? false,
      successfulDomains: finalSuccessfulDomains,
    });
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    serverLogger.error("[GuestCheckout] verify error:", errMessage, errStack);

    // If payment was verified but provisioning failed, create a fallback pending
    // order so admin can see it and retry manually (mirrors regular verify fallback)
    const isPaymentError =
      error instanceof Error &&
      (error.message.includes("Invalid payment signature") ||
        error.message.includes("Payment not captured") ||
        error.message.includes("Payment amount mismatch") ||
        error.message.includes("Order ID mismatch"));

    if (!isPaymentError && guestUser && orderId && cartItems?.length) {
      try {
        const totalAmount = cartItems.reduce(
          (sum: number, item: CartItem) => sum + (item.price || 0) * (item.registrationPeriod || 1),
          0
        );
        const fallbackOrder = await createOrder({
          orderId,
          userId: guestUser._id,
          userName: `${guestUser.firstName || ""} ${guestUser.lastName || ""}`.trim(),
          userEmail: guestEmail,
          paymentId: `pay_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          amount: totalAmount,
          currency: "INR",
          status: "completed",
          orderType:
            cartItems.some((i: CartItem) => !i.itemType || i.itemType === "domain") &&
            cartItems.some((i: CartItem) => i.itemType === "hosting")
              ? "bundle"
              : cartItems.some((i: CartItem) => i.itemType === "hosting")
              ? "hosting"
              : "domain",
          domains: cartItems.map((item: CartItem) => ({
            domainName: item.domainName,
            itemType: item.itemType || "domain",
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
                message: "Payment verified — provisioning failed, pending manual review",
                timestamp: new Date(),
                progress: 30,
              },
            ],
            error: "Provisioning failed — please contact support",
          })),
          successfulDomains: [],
          paymentVerification: {
            verifiedAt: new Date(),
            paymentStatus: "completed",
            paymentAmount: totalAmount,
            paymentCurrency: "INR",
            razorpayOrderId: razorpay_order_id,
          },
        });
        serverLogger.warn(`[GuestCheckout] Fallback order created: ${fallbackOrder.orderId} for ${guestEmail}`);
      } catch (fallbackErr: unknown) {
        const fbMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        serverLogger.error("[GuestCheckout] Fallback order creation also failed:", fbMessage);
      }
    }

    return NextResponse.json(
      { error: "Payment verification failed" },
      { status: 500 }
    );
  }
}
