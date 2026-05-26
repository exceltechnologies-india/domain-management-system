import { NextRequest, NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { listHostingsForUser } from "@/lib/services/hostings";
import { DirectAdminService } from "@/lib/directadmin";
import { getUserConfig as daGetUserConfig } from "@/lib/integrations/directadmin";
import { validatedBody, z } from "@/lib/api-validation";

const syncHostingStatusSchema = z.object({
  userId: z.string().min(1, "userId is required"),
});

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate Request
    if (!authorizeCronRequest(request)) {
      serverLogger.warn("[Worker:SyncHosting] Unauthorized access attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, syncHostingStatusSchema);
    if (!validation.ok) return validation.response;
    const { userId } = validation.data;

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
            const username = hosting.directAdminUsername;
            // M1 slice 8: typed outcome replaces the inline error-message
            // parsing ("User does not exist" / "cannot be found" /
            // ECONNREFUSED / DA_SERVER_DOWN) that used to live in the
            // catch block below.
            const configOutcome = await daGetUserConfig({ username });

            if (configOutcome.kind === "user_not_found") {
              serverLogger.warn(
                `[Worker:SyncHosting] User ${username} confirmed missing on DA. Marking as terminated.`
              );
              hosting.status = "terminated";
              hosting.autoRenew = false;
              await hosting.save();
              return;
            }
            if (configOutcome.kind === "da_unreachable") {
              serverLogger.warn(
                `[Worker:SyncHosting] DA unreachable for ${username}, skipping sync. Reason: ${configOutcome.reason}`
              );
              return;
            }
            if (configOutcome.kind === "hard_failure") {
              serverLogger.error(
                `[Worker:SyncHosting] getUserConfig hard_failure for ${username}: ${configOutcome.reason}`
              );
              return;
            }

            // configOutcome.kind === "found"
            const daConfig = configOutcome.config;

            // getUserDomains stays raw for now (separate slice). On error,
            // skip the domain-presence check rather than throwing — better
            // to keep the suspended/active sync from getUserConfig than
            // miss it entirely.
            let userDomains: string[] = [];
            try {
              userDomains = await DirectAdminService.getUserDomains(username);
            } catch (domErr) {
              serverLogger.warn(
                `[Worker:SyncHosting] getUserDomains failed for ${username} — proceeding without domain-presence check.`,
                domErr
              );
            }

            // Check if account is suspended.
            // "suspended" isn't yet in the IHosting status enum but is the
            // runtime value the worker writes — cast through unknown to
            // bypass strict TS until the schema is widened.
            const loose = hosting as unknown as { status: string };
            if (daConfig.suspended === "yes") {
              if (loose.status !== "suspended") {
                serverLogger.info(
                  `[Worker:SyncHosting] Updating status for ${username}: ${loose.status} -> suspended`
                );
                loose.status = "suspended";
                await hosting.save();
              }
            } else {
              // Account is active, but is the specific DOMAIN present?
              const normalizedUserDomains = userDomains.map((d) => d.toLowerCase());
              const isDomainPresent = normalizedUserDomains.includes(
                hosting.domainName.toLowerCase()
              );

              if (!isDomainPresent && userDomains.length > 0) {
                serverLogger.warn(
                  `[Worker:SyncHosting] Domain ${hosting.domainName} missing from DA account ${username}. Marking as terminated.`
                );
                hosting.status = "terminated";
                hosting.autoRenew = false;
                await hosting.save();
              } else if (hosting.status !== "active") {
                serverLogger.info(
                  `[Worker:SyncHosting] Updating status for ${username}: ${hosting.status} -> active`
                );
                hosting.status = "active";
                await hosting.save();
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
