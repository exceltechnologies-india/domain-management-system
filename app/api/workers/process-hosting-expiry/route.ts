import { NextRequest, NextResponse } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { getHostingById } from "@/lib/services/hostings";
import { getUserById } from "@/lib/services/users";
import { DirectAdminService } from "@/lib/directadmin";
// No renewal order and no bill are raised here: renewals are ResellerOS's.
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

        // B. Tell the customer — and raise NO renewal order.
        //
        // Renewals are ResellerOS's (owner decisions, 24-25 Sep 2026). This
        // worker used to create a pending DMS renewal Order at a DMS-computed
        // price and email it as a "renewal invoice" — including at the end of
        // every free TRIAL. That was a second place a renewal could be billed
        // and paid, on DMS's own account. Now the customer is told the service
        // is suspended and pointed at the panel, where Renew shows their
        // ResellerOS renewal bill (components/billing/RenewViaResellerOs.tsx).
        // When ResellerOS is paid its `hosting.renew` command moves the expiry
        // and unsuspends. The suspension itself is unchanged.
        const user = await getUserById(String(hosting.userId));
        if (user) {
            await EmailService.sendServiceSuspensionEmail(user.email, {
                serviceName: hosting.domainName,
                serviceType: "hosting",
            }).catch((err: unknown) =>
                serverLogger.error(
                    `[Worker] Suspension email failed for ${hosting.domainName}: ${err instanceof Error ? err.message : String(err)}`
                )
            );

            // WhatsApp "suspended, renew to restore" alongside the email.
            // Gated on a number on file + not opted out; best-effort.
            const userWithWa = user as unknown as { whatsappNumber?: string; whatsappOptOut?: boolean };
            if (userWithWa.whatsappNumber && userWithWa.whatsappOptOut !== true) {
                try {
                    await WhatsAppService.sendServiceSuspended(userWithWa.whatsappNumber, {
                        serviceName: hosting.domainName,
                        serviceType: "hosting",
                    });
                } catch (waErr) {
                    serverLogger.warn(
                        `[Worker] Suspension WhatsApp failed for ${hosting.domainName}: ${waErr instanceof Error ? waErr.message : String(waErr)}`
                    );
                }
            }
        } else {
            serverLogger.warn(`[Worker] ${hosting.domainName} suspended, but its user was not found — nobody was told.`);
        }

        // C. Update Local DB
        // "suspended" isn't in the IHosting status enum yet, but is the
        // runtime value the worker uses. Cast through unknown to bypass
        // strict TS until the schema is widened.
        (hosting as unknown as { status: string }).status = 'suspended';
        await hosting.save();
        
        serverLogger.info(`[Worker] Suspended ${hosting.domainName}; no DMS renewal order raised (renewals are ResellerOS's)`);
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
