import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { EmailService } from "@/lib/email";
import { getUserById } from "@/lib/services/users";
import User from "@/models/User";
import Hosting from "@/models/Hosting";
import {
  deletePendingHostingById,
  getPendingHostingById,
} from "@/lib/services/pending-hostings";
import connectDB from "@/lib/mongodb";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    await connectDB();

    const pendingEntry = await getPendingHostingById(id);

    if (!pendingEntry) {
        return secureErrorResponse("Pending entry not found", 404, "NOT_FOUND");
    }

    const { userId, domain, package: packageName, daUsername } = pendingEntry;

    // 3. Find user
    const user = await getUserById(String(userId));
    if (!user) {
      return secureErrorResponse("User associated with this entry not found.", 404, "USER_NOT_FOUND");
    }

    if (user.directAdminUsername) {
       // If user already has hosting, maybe this pending entry is stale or they got it elsewhere?
       // We should probably just delete the pending entry or mark it as resolved?
       // For now, let's error out.
      return secureErrorResponse("User already has a hosting account.", 400, "ALREADY_HAS_HOSTING");
    }

    // 4. Provision in DirectAdmin
    serverLogger.info(`Admin retrying hosting provision for ${user.email} on domain ${domain}`);
    
    try {
        await DirectAdminService.createUser(
            daUsername,
            user.email,
            domain,
            packageName
        );
    } catch (daError: unknown) {
         // Update error message in pending entry
         const daMessage = daError instanceof Error ? daError.message : "Retry failed at DA creation";
         pendingEntry.error = daMessage;
         await pendingEntry.save();
         throw daError; // rethrow to go to outer catch
    }

    // 4.5. Update DNS Nameservers to ResellerClub
    try {
      serverLogger.info(`Updating DNS nameservers for ${domain} to ResellerClub nameservers`);
      
      await DirectAdminService.updateDNSNameservers(
        daUsername,
        domain,
        DirectAdminService.NAMESERVERS
      );

      serverLogger.info(`DNS nameservers updated successfully for ${domain}`);
    } catch (dnsError: unknown) {
      // Log but don't fail the entire provisioning if DNS update fails
      const dnsMessage = dnsError instanceof Error ? dnsError.message : String(dnsError);
      serverLogger.warn(`Failed to update DNS nameservers for ${domain}: ${dnsMessage}`);
    }

    // 5. Update user in DB
    user.directAdminUsername = daUsername;
    user.hostingCreatedAt = new Date();
    // Default to 1 year expiry for manually provisioned accounts
    user.hostingExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await user.save();

    // 5.5. Create the Hosting record (provisioner.ts normally does this but was bypassed)
    const startDate = new Date();
    const expiryDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    try {
      await Hosting.create({
        userId,
        domainName: domain,
        planId: packageName,
        name: packageName,
        serverPackage: packageName,
        status: "active",
        startDate,
        expiryDate,
        next_action_at: new Date(expiryDate.getTime() - 15 * 24 * 60 * 60 * 1000),
        directAdminUsername: daUsername,
        orderId: `manual_retry_${Date.now()}`,
        autoRenew: false,
        billingType: "manual",
        isTrial: false,
        nameservers: DirectAdminService.NAMESERVERS,
      });
      serverLogger.info(`[AdminRetry] Hosting record created for ${domain} (user: ${user.email})`);
    } catch (hostingErr: unknown) {
      const hostingMessage = hostingErr instanceof Error ? hostingErr.message : String(hostingErr);
      serverLogger.error(`[AdminRetry] Failed to create Hosting record for ${domain}: ${hostingMessage}`);
      // Don't fail the request — DA account exists and user fields are set
    }

    // 6. Delete pending entry
    await deletePendingHostingById(id);

    // 7. Send Notification Email
    try {
        await EmailService.sendHostingProvisionedEmail(
            user.email,
            user.firstName || 'User',
            {
                domainName: domain,
                packageName: packageName,
                serverIp: process.env.DIRECTADMIN_IP || "136.115.64.54",
                nameservers: DirectAdminService.NAMESERVERS
            }
        );
        serverLogger.info(`Hosting provision email sent to ${user.email}`);
    } catch (emailError: unknown) {
        const emailMessage = emailError instanceof Error ? emailError.message : String(emailError);
        serverLogger.warn(`Failed to send hosting provision email to ${user.email}: ${emailMessage}`);
    }

    return secureJsonResponse({ 
      success: true, 
      message: `Hosting provisioned successfully for ${user.email}. Pending entry removed.`,
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to retry provision";
    serverLogger.error(`Admin Hosting Retry Error:`, message);
    return secureErrorResponse(
      message,
      500,
      "PROVISION_RETRY_FAILED"
    );
  }
}
