import { getUserById } from "@/lib/services/users";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import connectDB from "@/lib/mongodb";
import Order, { type IOrder } from "@/models/Order";
import type { HydratedDocument } from "mongoose";
import { ZohoBooksService } from "@/lib/zohobooks";
import { serverLogger } from "@/lib/server-logger";
import { claimPendingOrderForProcessing } from "@/lib/services/orders";

export const dynamic = "force-dynamic";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature");

    if (!WEBHOOK_SECRET) {
      serverLogger.error("❌ RAZORPAY_WEBHOOK_SECRET is not defined");
      return NextResponse.json({ error: "Configuration Error" }, { status: 500 });
    }

    if (!signature) {
      return NextResponse.json({ error: "Missing Signature" }, { status: 400 });
    }

    // 1. Verify Signature
    const generatedSignature = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (generatedSignature !== signature) {
      serverLogger.error("❌ Invalid Webhook Signature");
      return NextResponse.json({ error: "Invalid Signature" }, { status: 400 });
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event;



    if (event === "payment.captured") {
        await handlePaymentCaptured(payload);
    } else if (event === "refund.processed") {
        await handleRefundProcessed(payload);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error: unknown) {
    serverLogger.error("❌ Webhook Error", error);
    // Return 500 to trigger retry from Razorpay
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

interface RazorpayPaymentEntity {
  id: string;
  amount: number;
  currency: string;
  order_id?: string;
  description?: string;
  notes?: { receipt?: string };
}

interface PaymentCapturedPayload {
  payload: { payment: { entity: RazorpayPaymentEntity } };
}

interface RefundProcessedPayload {
  payload?: { refund?: { entity?: { id: string; payment_id: string; amount: number } } };
}

async function handlePaymentCaptured(payload: PaymentCapturedPayload) {
    await connectDB();
    const payment = payload.payload.payment.entity;
    const orderId = payment.notes?.receipt || payment.description;
    const razorpayOrderId = payment.order_id;

    const order = await Order.findOne({
        $or: [
            { orderId: orderId },
            { razorpayOrderId: razorpayOrderId },
        ],
    });

    // Defensive: with the pending-order persistence in place at /create-order,
    // the order should always exist by the time the webhook fires. If it
    // doesn't (legacy orphan payment, or someone bypassing /create-order),
    // log and return 200 so Razorpay doesn't retry-storm. We can't safely
    // create an order here — we don't have cart contents from the Razorpay
    // payload alone.
    if (!order) {
        serverLogger.warn(
            `[Webhook] Order not found for payment ...${payment.id?.slice(-6)} (rzpOrder=${razorpayOrderId}). Returning 200 to stop retries.`
        );
        return;
    }

    // Renewal / upgrade orders have their own verify-side handlers
    // (`handleRenewalPayment`, `handleUpgradePayment`) that know how to
    // reactivate hosting, advance expiry dates, etc. The webhook can't
    // safely run that logic from generic provisioning, so it stays out
    // of the way and lets /verify do the work.
    if (
        order.orderType === "renewal" ||
        order.orderType === "hosting_upgrade"
    ) {
        if (!order.razorpayPaymentId || order.razorpayPaymentId === "pending") {
            order.razorpayPaymentId = payment.id;
            await order.save();
        }
        serverLogger.info(
            `[Webhook] payment.captured for ${order.orderId}: orderType=${order.orderType} — deferring to /verify`
        );
        return;
    }

    // Idempotency: once verify (or a prior webhook delivery) has moved the
    // order past `pending`, the webhook becomes a no-op. We still record
    // the Razorpay payment id if the row is still carrying the placeholder.
    if (order.status !== "pending") {
        if (!order.razorpayPaymentId || order.razorpayPaymentId === "pending") {
            order.razorpayPaymentId = payment.id;
            await order.save();
        }
        serverLogger.info(
            `[Webhook] payment.captured for ${order.orderId}: status=${order.status} — no-op (verify/another delivery handled it)`
        );
        return;
    }

    // Status is `pending` — attempt to claim. If we lose the claim, /verify
    // is mid-flight; nothing for us to do. Use the order's stored
    // razorpayOrderId (string, non-null per schema) rather than the
    // optional one off the Razorpay payload.
    const claimed = await claimPendingOrderForProcessing(order.razorpayOrderId, {
        razorpayPaymentId: payment.id,
        paymentVerification: {
            verifiedAt: new Date(),
            paymentStatus: "captured",
            paymentAmount: payment.amount,
            paymentCurrency: payment.currency,
            razorpayOrderId: order.razorpayOrderId,
        },
    });
    if (!claimed) {
        serverLogger.info(
            `[Webhook] payment.captured for ${order.orderId}: claim lost to /verify — no-op`
        );
        return;
    }

    serverLogger.info(
        `[Webhook] Claimed pending order ${claimed.orderId} for provisioning (rzp=${razorpayOrderId})`
    );

    // Phase 4: Zoho Invoice Creation
    if (!claimed.zohoInvoiceId) {
        try {
            const zohoService = ZohoBooksService.getInstance();
            const user = await getUserById(String(claimed.userId));
            if (!user) throw new Error("User not found for order");

            const items = claimed.domains.map((d: IOrder["domains"][number]) => ({
                domainName: d.domainName,
                price: d.price,
                itemType: d.itemType,
                registrationPeriod: d.registrationPeriod,
                hostingPlan: d.hostingPlan,
            }));

            const invoice = await zohoService.createInvoice(
                {
                    orderId: claimed.orderId,
                    razorpayPaymentId: payment.id,
                    total: payment.amount,
                },
                user,
                items
            );

            if (invoice && invoice.invoice_id) {
                claimed.zohoInvoiceId = invoice.invoice_id;
                claimed.invoiceNumber = invoice.invoice_number;
                await claimed.save();
            } else {
                throw new Error("Zoho Invoice creation returned no ID");
            }
        } catch (error) {
            serverLogger.error("❌ Zoho Sync Failed", error);
            // Don't rethrow — let provisioning proceed. The self-heal cron
            // picks up `creation_failed` orders later. Throwing here would
            // cause Razorpay to retry the webhook even though the payment
            // is safely captured and the order is being provisioned.
            try {
                claimed.zohoInvoiceId = "creation_failed";
                await claimed.save();
            } catch (_) {}
        }
    }

    // Phase 5: Provisioning
    try {
        const results = await provisionServices(claimed);
        const successCount = results.successfulDomains.length;
        const failCount = results.failedDomains.length;
        serverLogger.info(
            `[Webhook] Provisioned ${claimed.orderId}: success=${successCount} fail=${failCount}`
        );
        claimed.status = "completed";
        await claimed.save();
    } catch (error) {
        serverLogger.error("❌ [Webhook] Provisioning Failed", error);
        // Leave the order in `processing` so admin can inspect; rethrow so
        // Razorpay retries the webhook and we get another shot at provisioning.
        throw error;
    }
}

async function handleRefundProcessed(payload: RefundProcessedPayload) {
  await connectDB();

  const refund = payload.payload?.refund?.entity;
  if (!refund) {
    serverLogger.warn("[Webhook] refund.processed payload missing refund entity — skipping");
    return;
  }

  const paymentId: string = refund.payment_id;
  const refundId: string = refund.id;
  const refundAmountPaise: number = refund.amount;

  const order = await Order.findOne({ razorpayPaymentId: paymentId });
  if (!order) {
    serverLogger.warn(`[Webhook] refund.processed: no order found for payment ...${paymentId?.slice(-6)}`);
    return;
  }

  if (!order.zohoInvoiceId || order.zohoInvoiceId === "creation_failed") {
    serverLogger.warn(`[Webhook] refund.processed: order ${order.orderId} has no Zoho invoice — skipping credit note`);
    return;
  }

  try {
    const zohoService = ZohoBooksService.getInstance();
    const User = (await import("@/models/User")).default;
    const user = await getUserById(String(order.userId));
    if (!user) throw new Error("User not found for refunded order");

    // Look up the Zoho contact for this user
    const contact = await zohoService.getContactByEmail(user.email);
    if (!contact) throw new Error(`Zoho contact not found for ${user.email}`);

    await zohoService.createCreditNote(
      order.zohoInvoiceId,
      contact.contact_id,
      refundId,
      refundAmountPaise,
      order.orderId
    );

    serverLogger.info(`[Webhook] Credit note created for refund ${refundId} on order ${order.orderId}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error(`[Webhook] Failed to create credit note for refund ${refundId}`, message);
    // Don't throw — Razorpay doesn't need to retry refund webhooks for accounting failures.
    // Admin should be alerted via Cloud Logging / monitoring alert.
  }
}

async function provisionServices(order: HydratedDocument<IOrder>) {
    const User = (await import("@/models/User")).default;
    const user = await getUserById(String(order.userId));
    if (!user) throw new Error("User not found for provisioning");
    
    // Import dynamically to avoid circle if any (though lib should be fine)
    const { ProvisioningService } = await import("@/lib/provisioning");
    
    return await ProvisioningService.provisionOrder(order, user);
}
