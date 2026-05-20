import { NextRequest, NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { listHostingsForUser } from "@/lib/services/hostings";
import { DirectAdminService } from "@/lib/directadmin";

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate Request
    if (!authorizeCronRequest(request)) {
      serverLogger.warn("[Worker:SyncHosting] Unauthorized access attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userId } = await request.json();

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    // 2. Fetch Hostings — sync path needs every hosting, no truncation.
    const hostings = await listHostingsForUser(userId, { limit: 0 });

    if (!hostings || hostings.length === 0) {
      return NextResponse.json({ success: true, message: "No hostings found" });
    }

    serverLogger.info(`[Worker:SyncHosting] Starting sync for user ${userId}, found ${hostings.length} hostings`);

    // 3. Sync Logic (Adapted from dashboard/route.ts)
    const syncPromises = hostings.map(async (hosting) => {
        // Only check active or suspended accounts
        if (['active', 'suspended'].includes(hosting.status)) {
          // Sync status with DirectAdmin
          if (hosting.directAdminUsername) {
            try {
              // Fetch config AND domains to verify specific domain existence
              const [daConfig, userDomains] = await Promise.all([
                 DirectAdminService.getUserConfig(hosting.directAdminUsername),
                 DirectAdminService.getUserDomains(hosting.directAdminUsername)
              ]);
              
              // Check if account is suspended.
              // "suspended" isn't yet in the IHosting status enum but is the
              // runtime value the worker writes — cast through unknown to
              // bypass strict TS until the schema is widened.
              const loose = hosting as unknown as { status: string };
              if (daConfig.suspended === "yes") {
                if (loose.status !== 'suspended') {
                   serverLogger.info(`[Worker:SyncHosting] Updating status for ${hosting.directAdminUsername}: ${loose.status} -> suspended`);
                   loose.status = 'suspended';
                   await hosting.save();
                }
              } else {
                 // Account is active, but is the specific DOMAIN present?
                 const normalizedUserDomains = userDomains.map(d => d.toLowerCase());
                 const isDomainPresent = normalizedUserDomains.includes(hosting.domainName.toLowerCase());

                 if (!isDomainPresent) {
                     serverLogger.warn(`[Worker:SyncHosting] Domain ${hosting.domainName} missing from DA account ${hosting.directAdminUsername}. Marking as terminated.`);
                     hosting.status = 'terminated';
                     hosting.autoRenew = false;
                     await hosting.save();
                 } else if (hosting.status !== 'active') {
                   serverLogger.info(`[Worker:SyncHosting] Updating status for ${hosting.directAdminUsername}: ${hosting.status} -> active`);
                   hosting.status = 'active';
                   await hosting.save();
                 }
              }
            } catch (error: unknown) {
               // Handle "User does not exist" error
               const errorMessage = error instanceof Error ? error.message : String(error);
               
               const isConnectionError = errorMessage.includes("getsockopt") || 
                                         errorMessage.includes("ETIMEDOUT") || 
                                         errorMessage.includes("ECONNREFUSED") ||
                                         errorMessage.includes("DA_SERVER_DOWN");

               if (isConnectionError) {
                   serverLogger.warn(`[Worker:SyncHosting] Connection error for ${hosting.directAdminUsername}. Skipping sync. Error: ${errorMessage}`);
                   return; // Skip sync, keep local status
               }

               if (errorMessage.includes("User does not exist") || errorMessage.includes("cannot be found")) {
                  serverLogger.warn(`[Worker:SyncHosting] User ${hosting.directAdminUsername} confirmed missing on DA. Marking as terminated.`);
                  hosting.status = 'terminated';
                  hosting.autoRenew = false;
                  await hosting.save();
               } else {
                  serverLogger.error(`[Worker:SyncHosting] Failed to check status for ${hosting.directAdminUsername}: ${errorMessage}`, { error });
               }
            }
          }
        }
    });

    await Promise.allSettled(syncPromises);

    serverLogger.info(`[Worker:SyncHosting] Sync completed for user ${userId}`);

    return NextResponse.json({ success: true, message: "Sync completed" });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Sync failed";
    serverLogger.error("[Worker:SyncHosting] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
