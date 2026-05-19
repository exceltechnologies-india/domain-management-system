import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import HostingPlan from "@/models/HostingPlan";
import { connectToDatabase } from "@/lib/mongoose";
import { HOSTING_PLANS } from "@/config/hosting-plans";

/**
 * POST /api/admin/hosting/packages/defaults
 * Creates the default hosting packages (Starter, Standard, Plus) 
 * in DirectAdmin and the local database.
 * Restricted to Admins only.
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized", 403, "FORBIDDEN");
    }

    await connectToDatabase();

    const results = [];
    const errors = [];

    // 2. Iterate through defined default plans
    for (const planKey of Object.keys(HOSTING_PLANS)) {
      const planConfig = HOSTING_PLANS[planKey];
      const pkgName = planConfig.serverPackage;

      try {
        // Check if exists in DB
        const existingPlan = await HostingPlan.findOne({ planId: pkgName });
        
        if (existingPlan) {
          results.push({ name: pkgName, status: "skipped", reason: "Already exists in database" });
          continue;
        }

        // Prepare DA options
        // -1 or 0 in config implies unlimited. 
        // DirectAdmin typically accepts "unlimited" or a specific value.
        // We'll use "unlimited" string for DA if <= 0.
        const daQuota = planConfig.quotaMB <= 0 ? "unlimited" : planConfig.quotaMB.toString();
        const daBandwidth = planConfig.bandwidthMB <= 0 ? "unlimited" : planConfig.bandwidthMB.toString();

        // 3. Create in DirectAdmin
        // We attempt to create it. If it exists, DA might return error or success.
        // DirectAdminService.createPackage handles duplicate checks gracefully usually or throws.
        try {
            await DirectAdminService.createPackage(pkgName, {
                quota: daQuota,
                bandwidth: daBandwidth,
                // Add limits for unlimited packages to prevent abuse if needed, 
                // but for defaults we follow the plan config.
                // We can extend this with more options like domainptr etc from config if available.
            });
        } catch (daError: unknown) {
            const daMessage = daError instanceof Error ? daError.message : String(daError);
            // If error says "already exists", we can proceed to create/sync in DB
            if (daMessage.includes("already exists")) {
                serverLogger.info(`Package ${pkgName} already exists in DirectAdmin, syncing to DB.`);
            } else {
                throw daError; // Rethrow other errors
            }
        }

        // 4. Create in DB
        // For DB, 0 means unlimited usually, or we store the big number?
        // HostingPlan model has min: 0. So -1 is invalid. We use 0 for unlimited.
        const dbQuota = planConfig.quotaMB <= 0 ? 0 : planConfig.quotaMB;
        const dbBandwidth = planConfig.bandwidthMB <= 0 ? 0 : planConfig.bandwidthMB;

        const newPlan = await HostingPlan.create({
          planId: pkgName,
          name: planConfig.name,
          description: planConfig.description,
          price: planConfig.price,
          currency: planConfig.currency || "INR",
          features: planConfig.features,
          directAdminPackage: pkgName,
          quota: dbQuota,
          bandwidth: dbBandwidth,
          isActive: true
        });

        results.push({ name: pkgName, status: "created", data: newPlan });

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        serverLogger.error(`Failed to create default package ${pkgName}:`, message);
        errors.push({ name: pkgName, error: message });
      }
    }

    // 5. Determine overall status
    const hasSuccess = results.some(r => r.status === "created" || r.status === "skipped");
    const hasErrors = errors.length > 0;

    if (!hasSuccess && hasErrors) {
      return secureJsonResponse({
        success: false,
        message: "Failed to create any default packages. See errors for details.",
        data: { results, errors }
      }, 500); // Or 207 Multi-Status if we wanted to be fancy, but 500/400 is safer for now
    }

    return secureJsonResponse({
      success: true,
      message: hasErrors 
        ? "Default packages processed with some errors" 
        : "Default packages processing complete",
      data: { results, errors }
    });

  } catch (error: unknown) {
    serverLogger.error("Default Packages Creation Error:", error);
    return secureErrorResponse(
      "Failed to create default packages",
      500,
      "DEFAULT_PACKAGES_FAILED"
    );
  }
}
