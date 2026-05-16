import { NextRequest, NextResponse } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import crypto from "crypto";
import Hosting from "@/models/Hosting";
import { AuthService } from "@/lib/auth";
import { getCurrentDate } from "@/lib/dateUtils";
import { createHttpTask } from "@/lib/cloud-tasks";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // 1. Auth: timing-safe CRON_SECRET header check, fallback to admin session
    const cronSecret = process.env.CRON_SECRET;
    const providedSecret = request.headers.get("x-cron-secret") ?? "";
    const isCron =
      cronSecret !== undefined &&
      cronSecret.length > 0 &&
      providedSecret.length === cronSecret.length &&
      crypto.timingSafeEqual(Buffer.from(providedSecret), Buffer.from(cronSecret));

    if (!isCron) {
        const isAdmin = await AuthService.isAdmin(request);
        if (!isAdmin) {
            return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
        }
    }

    await connectDB();

    // 2. Find Expired Active Hostings
    const today = getCurrentDate();
    const expiredHostings = await Hosting.find({
        status: 'active',
        expiryDate: { $lt: today, $ne: null }
    }).select('_id domainName directAdminUsername'); // Select minimal fields

    serverLogger.info(`[AutoSuspend] Found ${expiredHostings.length} expired active hosting accounts.`);

    const results = {
        queued: 0,
        failed: 0,
        details: [] as string[]
    };

    // 3. Queue Tasks
    const queueName = process.env.GCP_QUEUE_NAME || 'hosting-expiry-queue';
    const workerUrl = `${process.env.NEXTAUTH_URL}/api/v1/workers/process-hosting-expiry`;

    for (const hosting of expiredHostings) {
        try {
            await createHttpTask(queueName, workerUrl, { hostingId: hosting._id });
            results.queued++;
            results.details.push(`Queued: ${hosting.domainName}`);
        } catch (error: any) {
            serverLogger.error(`[AutoSuspend] Failed to queue task for ${hosting.domainName}:`, error.message);
            results.failed++;
            results.details.push(`Failed to queue: ${hosting.domainName}`);
        }
    }
    
    return secureJsonResponse({
        success: true,
        data: results
    });

  } catch (error: any) {
    serverLogger.error("[AutoSuspend] Critical Error:", error.message);
    return secureErrorResponse(
      "Internal Server Error during auto-suspend queuing",
      500,
      "AUTO_SUSPEND_FAILED"
    );
  }
}
