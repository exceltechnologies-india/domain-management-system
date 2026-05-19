import { NextRequest, NextResponse } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import crypto from "crypto";
import Hosting from "@/models/Hosting";
import { getUserById } from "@/lib/services/users";
import User from "@/models/User";
import Order, { type IOrder } from "@/models/Order";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { DirectAdminService } from "@/lib/directadmin";
import { HOSTING_PLANS } from "@/config/hosting-plans";
// ZohoBooksService is intentionally NOT imported here.
// Zoho invoices are created only after successful payment (in /api/payments/verify).
import { EmailService } from "@/lib/email";

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate the worker request
    const cronSecret = process.env.CRON_SECRET;
    const providedSecret = request.headers.get("x-cron-secret") ?? "";
    const isAuthorized =
      cronSecret !== undefined &&
      cronSecret.length > 0 &&
      providedSecret.length === cronSecret.length &&
      crypto.timingSafeEqual(Buffer.from(providedSecret), Buffer.from(cronSecret));

    if (!isAuthorized) {
        return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const body = await request.json();
    const { hostingId } = body;

    if (!hostingId) {
        return secureErrorResponse("Missing hostingId", 400, "BAD_REQUEST");
    }

    await connectDB();

    // 2. Fetch Hosting and Verify Status (Idempotency Check)
    const hosting = await Hosting.findById(hostingId);

    if (!hosting) {
        serverLogger.warn(`[Worker] Hosting not found: ${hostingId}`);
        return secureJsonResponse({ success: false, message: "Hosting not found" });
    }

    if (hosting.status !== 'active') {
        serverLogger.info(`[Worker] Hosting ${hostingId} is not active (Status: ${hosting.status}), skipping.`);
        return secureJsonResponse({ success: true, message: "Skipped (not active)" });
    }

    // Double check expiry just in case
    if (!hosting.expiryDate || new Date(hosting.expiryDate) > new Date()) {
         serverLogger.info(`[Worker] Hosting ${hostingId} is not expired, skipping.`);
         return secureJsonResponse({ success: true, message: "Skipped (not expired)" });
    }

    serverLogger.info(`[Worker] Processing expiry for ${hosting.domainName} (User: ${hosting.directAdminUsername})`);

    // 3. Process Suspension & Renewal
    try {
        // A. Suspend User in DirectAdmin
        if (hosting.directAdminUsername) {
                await DirectAdminService.suspendUser(hosting.directAdminUsername, "Expired Subscription (Auto-Suspend)");
        }

        // B. Create Pending Renewal Order & Send Notification
        // NOTE: We do NOT create a Zoho Books invoice here.
        // The invoice will be created (and immediately marked paid) only after
        // the user completes the renewal payment. This avoids a "due invoice"
        // appearing in Zoho Books before the user has paid anything.
        const user = await getUserById(hosting.userId);
        
        if (user) {
            let renewalPrice = 0;
            let period = 1;
            let periodUnit: 'minutes' | 'months' | 'years' = 'months';

            // Logic to find renewal price from original order
            if (hosting.orderId) {
                const originalOrder = await Order.findOne({ orderId: hosting.orderId });
                if (originalOrder && originalOrder.domains) {
                    type OrderDomainSub = IOrder['domains'][number] & { hostingPlan?: { planId?: string; serverPackage?: string } };
                    let domainItem = originalOrder.domains.find((d: OrderDomainSub) => d.domainName === hosting.domainName) as OrderDomainSub | undefined;

                    if (!domainItem) {
                        domainItem = originalOrder.domains.find((d: OrderDomainSub) =>
                            d.itemType === 'hosting' && (
                                d.hostingPlan?.planId === hosting.planId ||
                                d.hostingPlan?.serverPackage === hosting.planId ||
                                d.hostingPlan?.serverPackage === hosting.serverPackage
                            )
                        ) as OrderDomainSub | undefined;
                    }

                    if (domainItem && domainItem.price) {
                        renewalPrice = domainItem.price;
                        if (domainItem.periodUnit && (domainItem.periodUnit === 'minutes' || domainItem.periodUnit === 'months' || domainItem.periodUnit === 'years')) {
                            periodUnit = domainItem.periodUnit;
                        }
                        if (domainItem.registrationPeriod) period = domainItem.registrationPeriod;
                    }
                }
            }

            if (!renewalPrice && hosting.planId) {
                const plan = await getPlanByPlanId(hosting.planId);
                if (plan) renewalPrice = plan.price || 0;
            }

            if (!renewalPrice) renewalPrice = HOSTING_PLANS.starter.price;
            
            // Create a pending Order so the payment-verify flow can find it
            const renewalOrderId = `ord_renew_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            
            const renewalOrder = await Order.create({
                orderId: renewalOrderId,
                userId: user._id,
                paymentId: `pay_pending_${Date.now()}`,
                razorpayOrderId: `rpay_renew_${Date.now()}`,
                razorpayPaymentId: 'pending',
                razorpaySignature: 'pending',
                amount: renewalPrice,
                currency: 'INR',
                status: 'pending',
                paymentVerification: {
                    verifiedAt: new Date(),
                    paymentStatus: 'pending',
                    paymentAmount: renewalPrice,
                    paymentCurrency: 'INR',
                    razorpayOrderId: 'pending'
                },
                domains: [{
                    domainName: hosting.domainName,
                    price: renewalPrice,
                    currency: 'INR',
                    registrationPeriod: period,
                    periodUnit: periodUnit,
                    status: 'pending',
                    itemType: 'hosting',
                    hostingPlan: {
                        planId: hosting.planId,
                        name: hosting.name,
                        serverPackage: hosting.serverPackage
                    },
                    bookingStatus: [{
                        step: 'suspended',
                        message: 'Awaiting Renewal Payment',
                        progress: 10
                    }]
                }]
            });

            // Mark hosting as pending renewal (no invoice yet)
            hosting.renewalStatus = 'pending';

            // Send renewal notification email (no invoice number — invoice will be
            // created only after the user pays)
            await EmailService.sendRenewalInvoiceEmail(
                user.email,
                `${user.firstName} ${user.lastName}`,
                {
                    domainName: hosting.domainName,
                    invoiceAmount: renewalOrder.amount,
                    // invoiceNumber intentionally omitted — no invoice created yet
                    dueDate: new Date(),
                    renewalOrderId: renewalOrder.orderId,
                    renewalPeriod: period,
                    periodUnit: periodUnit
                }
            );
        }

        // C. Update Local DB
        hosting.status = 'suspended';
        await hosting.save();
        
        serverLogger.info(`[Worker] Successfully suspended and invoiced ${hosting.domainName}`);
        return secureJsonResponse({ success: true, hostingId });

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        serverLogger.error(`[Worker] Error processing ${hosting.domainName}: ${message}`);
        // Return 500 so Cloud Tasks retries for transient errors.
        return secureErrorResponse(message, 500, "PROCESSING_FAILED");
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[Worker] Critical Error:", message);
    return secureErrorResponse("Internal Server Error", 500, "INTERNAL_ERROR");
  }
}
