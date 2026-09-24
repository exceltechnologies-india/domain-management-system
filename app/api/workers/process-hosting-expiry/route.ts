import { NextRequest, NextResponse } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { getHostingById } from "@/lib/services/hostings";
import { getUserById } from "@/lib/services/users";
import { createOrder } from "@/lib/services/orders";
import { DirectAdminService } from "@/lib/directadmin";
import { hostingCharge } from "@/lib/pricing/hosting-price";
// No invoice is issued here — invoices are issued only after a successful
// payment (in /api/payments/verify and the renewal paths).
import { EmailService } from "@/lib/email";
import { WhatsAppService } from "@/lib/whatsapp";
import { validatedBody, z } from "@/lib/api-validation";

const processHostingExpirySchema = z.object({
  hostingId: z.string().min(1, "Missing hostingId"),
});

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate the worker request
    if (!authorizeCronRequest(request)) {
        return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const validation = await validatedBody(request, processHostingExpirySchema);
    if (!validation.ok) return validation.response;
    const { hostingId } = validation.data;

    // 2. Fetch Hosting and Verify Status (Idempotency Check)
    const hosting = await getHostingById(hostingId);

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
        // NOTE: We do NOT issue an invoice here. The tax invoice is issued only
        // after the user completes the renewal payment, so no "due invoice"
        // exists for money nobody has paid yet.
        const user = await getUserById(String(hosting.userId));
        
        // The renewal is one year at ResellerOS's price + 18% GST — the same
        // charge api/user/hosting/renew takes (owner decision, 24 Sep 2026).
        //
        // This used to take the ORIGINAL order line's `price` as the amount.
        // That field is a per-MONTH figure (the line is price × 12 months), so
        // a yearly Starter renewal was raised — and emailed to the customer —
        // as ₹49.99. And when nothing matched it fell back to Starter's price
        // for whatever plan the customer actually had. Both were §2: a
        // plausible number standing in for the real one.
        const renewalCharge = hostingCharge(hosting.planId, 'yearly');
        if (user && !renewalCharge) {
            serverLogger.error(
                `[Worker] ${hosting.domainName} suspended, but plan "${hosting.planId}" has no ResellerOS price, ` +
                `so no renewal order or renewal email was sent. ACTION: renew this account by hand and tell the customer.`
            );
        }

        if (user && renewalCharge) {
            const renewalPrice = renewalCharge.inclGst;
            const period = renewalCharge.months;
            const periodUnit: 'minutes' | 'months' | 'years' = 'months';
            
            // Create a pending Order so the payment-verify flow can find it
            const renewalOrderId = `ord_renew_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            
            const renewalOrder = await createOrder({
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
                    // Per-month figure: the line totals price × registrationPeriod.
                    price: renewalPrice / period,
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

            // Mark hosting as pending renewal (no invoice yet).
            // `renewalStatus` is a loose-typed field — cast preserves the
            // mongoose persistence path while satisfying strict TS.
            (hosting as unknown as { renewalStatus?: string }).renewalStatus = 'pending';

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

            // WhatsApp renewal-due nudge alongside the email — this is the
            // expiry→suspend→renew event, so the "suspended, renew to
            // restore" template is the accurate fit (vs the "expires in N
            // days" reminder, which would read wrong for an already-expired
            // account). Gated on a WhatsApp number on file + not opted out;
            // self-gating on the master flag inside the service. Best-effort:
            // a WhatsApp failure never blocks the suspension/renewal flow.
            const userWithWa = user as unknown as { whatsappNumber?: string; whatsappOptOut?: boolean };
            if (userWithWa.whatsappNumber && userWithWa.whatsappOptOut !== true) {
                try {
                    await WhatsAppService.sendServiceSuspended(userWithWa.whatsappNumber, {
                        serviceName: hosting.domainName,
                        serviceType: "hosting",
                    });
                } catch (waErr) {
                    serverLogger.warn(
                        `[Worker] Renewal-due WhatsApp failed for ${hosting.domainName}: ${waErr instanceof Error ? waErr.message : String(waErr)}`
                    );
                }
            }
        }

        // C. Update Local DB
        // "suspended" isn't in the IHosting status enum yet, but is the
        // runtime value the worker uses. Cast through unknown to bypass
        // strict TS until the schema is widened.
        (hosting as unknown as { status: string }).status = 'suspended';
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
