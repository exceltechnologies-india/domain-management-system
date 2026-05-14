import { NextRequest, NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import crypto from "crypto";
import Hosting from "@/models/Hosting";
import { DirectAdminService } from "@/lib/directadmin";

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate Request
    const cronSecret = process.env.CRON_SECRET;
    const providedSecret = request.headers.get("x-cron-secret") ?? "";
    const isAuthorized =
      cronSecret !== undefined &&
      cronSecret.length > 0 &&
      providedSecret.length === cronSecret.length &&
      crypto.timingSafeEqual(Buffer.from(providedSecret), Buffer.from(cronSecret));
    if (!isAuthorized) {
      serverLogger.warn("[Worker:SyncHosting] Unauthorized access attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userId } = await request.json();

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    await connectDB();

    // 2. Fetch Hostings
    const hostings = await Hosting.find({ userId }).sort({ createdAt: -1 });

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
              
              // Check if account is suspended
              if (daConfig.suspended === "yes") {
                if (hosting.status !== 'suspended') {
                   serverLogger.info(`[Worker:SyncHosting] Updating status for ${hosting.directAdminUsername}: ${hosting.status} -> suspended`);
                   hosting.status = 'suspended';
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
            } catch (error: any) {
               // Handle "User does not exist" error
               const errorMessage = error.message || '';
               
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

  } catch (error: any) {
    serverLogger.error("[Worker:SyncHosting] Error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
