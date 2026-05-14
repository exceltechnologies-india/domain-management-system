import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { ZohoBooksService } from "@/lib/zohobooks";
import { serverLogger } from "@/lib/server-logger";

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
  } catch (error: any) {
    serverLogger.error("❌ Webhook Error", error);
    // Return 500 to trigger retry from Razorpay
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

async function handlePaymentCaptured(payload: any) {
    await connectDB();
    const payment = payload.payload.payment.entity;
    // receipt holds the Internal Order ID (ORD...) as per Phase 2.1
    const orderId = payment.notes?.receipt || payment.description; 
    
    // Fallback: search by Razorpay Order ID if provided
    const razorpayOrderId = payment.order_id;



    let order = await Order.findOne({ 
        $or: [
            { orderId: orderId },
            { razorpayOrderId: razorpayOrderId }
        ]
    });

    if (!order) {
        serverLogger.error(`❌ Order not found for payment ...${payment.id?.slice(-6)}`);
        throw new Error("Order not found");
    }

    // 2. Idempotency & Phase 3.2: Mark as PAID
    if (order.status === 'paid' || order.status === 'processing' || order.status === 'completed') {
        // We continue to ensure Invoice is synced even if previously marked paid
    } else {
        order.status = 'paid';
        order.razorpayPaymentId = payment.id;
        order.paymentVerification = {
            verifiedAt: new Date(),
            paymentStatus: 'captured',
            paymentAmount: payment.amount,
            paymentCurrency: payment.currency,
            razorpayOrderId: payment.order_id
        };
        await order.save();
    }

    // 4. Phase 4: Zoho Invoice Creation
    // "ONLY AFTER: Zoho invoice = PAID"
    
    if (!order.zohoInvoiceId) {
        try {
            const zohoService = ZohoBooksService.getInstance();
            
            // We need User details and Items to create invoice
            // Fetch User
           const User = (await import("@/models/User")).default; // Dynamic import to avoid cycles/init issues
           const user = await User.findById(order.userId);
           if (!user) throw new Error("User not found for order");

           // Reconstruct items from Order (since we need to pass them to Zoho)
           // Order.domains contains item details including price
           const items = order.domains.map((d: any) => ({
               domainName: d.domainName,
               price: d.price,
               itemType: d.itemType,
               registrationPeriod: d.registrationPeriod,
               hostingPlan: d.hostingPlan
           }));

            const invoice = await zohoService.createInvoice(
                {
                    orderId: order.orderId,
                    razorpayPaymentId: payment.id,
                    total: payment.amount
                },
                user,
                items
            );

            if (invoice && invoice.invoice_id) {
                order.zohoInvoiceId = invoice.invoice_id;
                order.invoiceNumber = invoice.invoice_number;
                await order.save();
            } else {
                throw new Error("Zoho Invoice creation returned no ID");
            }
        } catch (error) {
            serverLogger.error("❌ Zoho Sync Failed", error);
            throw error;
        }
    }

    // 5. Phase 5: Provisioning
    // "ONLY AFTER: Zoho invoice = PAID" (We confirmed ID exists above)
    
    if (order.status !== 'completed') {
        // Mark as Processing
        order.status = 'processing';
        await order.save();

        try {
            const results = await provisionServices(order);
            
            const successCount = results.successfulDomains.length;
            const failCount = results.failedDomains.length;
            
            order.status = 'completed';
            await order.save();
            
        } catch (error) {
            serverLogger.error("❌ Provisioning Failed", error);
            throw error;
        }
    }
}

async function handleRefundProcessed(payload: any) {
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
    const user = await User.findById(order.userId);
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
  } catch (error: any) {
    serverLogger.error(`[Webhook] Failed to create credit note for refund ${refundId}`, error.message || error);
    // Don't throw — Razorpay doesn't need to retry refund webhooks for accounting failures.
    // Admin should be alerted via Cloud Logging / monitoring alert.
  }
}

async function provisionServices(order: any) {
    const User = (await import("@/models/User")).default;
    const user = await User.findById(order.userId);
    if (!user) throw new Error("User not found for provisioning");
    
    // Import dynamically to avoid circle if any (though lib should be fine)
    const { ProvisioningService } = await import("@/lib/provisioning");
    
    return await ProvisioningService.provisionOrder(order, user);
}
