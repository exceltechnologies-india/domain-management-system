import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import HostingPlan from "@/models/HostingPlan";
import { connectToDatabase } from "@/lib/mongoose";
import { HOSTING_PLANS } from "@/config/hosting-plans";

/**
 * GET /api/admin/hosting/packages
 * Lists available hosting packages from DirectAdmin and syncs with local DB.
 * Restricted to Admins only.
 */
export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized", 403, "FORBIDDEN");
    }

    await connectToDatabase();

    // 1. Fetch from DirectAdmin with Fallback
    let daPackages: string[] = [];
    let isDaAvailable = true;

    try {
        // specific timeout for DA call to avoid long hangs
        const daPromise = DirectAdminService.listPackages();
        const timeoutPromise = new Promise<string[]>((_, reject) => 
            setTimeout(() => reject(new Error('DA_TIMEOUT')), 5000)
        );
        
        daPackages = await Promise.race([daPromise, timeoutPromise]);
    } catch (e) {
        serverLogger.warn("DA List Packages failed or timed out, switching to DB fallback:", e);
        isDaAvailable = false;
    }

    // 2. Sync or Fetch from DB
    let syncedPackages = [];

    if (isDaAvailable) {
        // We want to make sure all DA packages exist in our DB
        syncedPackages = await Promise.all(
          daPackages.map(async (pkgName) => {
            // Fetch details from DA
            let details: any = {};
            try {
                details = await DirectAdminService.getPackageDetails(pkgName);
            } catch (e) {
                serverLogger.warn(`Failed to fetch details for package ${pkgName}:`, e);
            }
    
            // Try to find existing plan
            let plan = await HostingPlan.findOne({ planId: pkgName });
    
            // Helper to parse unlimited
            const parseDAValue = (val: any) => {
                if (typeof val === 'string' && val.toLowerCase() === 'unlimited') return -1;
                return parseInt(val) || 0;
            };
    
            const parsedQuota = parseDAValue(details.quota);
            const parsedBandwidth = parseDAValue(details.bandwidth);
    
            if (!plan) {
              // Try to find matching config for default price/name
              const planConfig = Object.values(HOSTING_PLANS).find(cp => cp.serverPackage === pkgName);
              
              // Create default entry if not exists
              plan = await HostingPlan.create({
                planId: planConfig?.id || pkgName,
                name: planConfig?.name || pkgName, 
                directAdminPackage: pkgName,
                price: planConfig?.price || 0,
                quota: parsedQuota, 
                bandwidth: parsedBandwidth,
                isActive: true,
                details: details,
              });
            } else {
                // Update technical details only (keep price intact unless it was 0 and we have a config)
                plan.quota = parsedQuota;
                plan.bandwidth = parsedBandwidth;
                plan.details = details;
                
                // If price is 0, try to recover from config
                if (plan.price === 0) {
                    const planConfig = Object.values(HOSTING_PLANS).find(cp => cp.serverPackage === pkgName);
                    if (planConfig) plan.price = planConfig.price;
                }
                
                await plan.save();
            }
            return plan;
          })
        );
    } else {
        // Fallback: Fetch from DB only
        syncedPackages = await HostingPlan.find({ isActive: true });
    }
    
    serverLogger.info(`Admin List Packages: Returning ${syncedPackages.length} packages (Source: ${isDaAvailable ? 'DA+DB' : 'DB Only'})`);

    return secureJsonResponse({
      success: true,
      data: syncedPackages,
      source: isDaAvailable ? 'live' : 'db',
      warning: isDaAvailable ? null : 'DirectAdmin unreachable. Showing cached packages.'
    });
  } catch (error: any) {
    serverLogger.error('Admin List Packages Error:', error.message || 'Unknown error');
    
    // Even global error, try to return DB if possible
    try {
        const fallbackPackages = await HostingPlan.find({ isActive: true });
        return secureJsonResponse({
            success: true, 
            data: fallbackPackages, 
            source: 'db',
            warning: 'System error. Showing cached packages.'
        });
    } catch (dbError) {
        return secureErrorResponse(
            "Failed to fetch hosting packages from both Live and DB sources",
            500,
            "PACKAGES_FETCH_FAILED"
        );
    }
  }
}

/**
 * POST /api/admin/hosting/packages
 * Creates a new hosting package in DirectAdmin and local DB.
 * Restricted to Admins only.
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      serverLogger.warn("Admin Package Creation Attempt: Unauthorized access");
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    await connectToDatabase();

    // 2. Parse request body
    const body = await request.json();
    const { 
      packageName, 
      quota, 
      bandwidth, 
      price,
      description,
      features,
      ...otherOptions 
    } = body;

    if (!packageName) {
      return secureErrorResponse("Package name is required.", 400, "INVALID_INPUT");
    }

    // 3. Create package via DirectAdmin API
    serverLogger.info(`Admin starting package creation: ${packageName}`);
    const daResult = await DirectAdminService.createPackage(packageName, {
      quota,
      bandwidth,
      ...otherOptions
    });

    // 4. Create in local DB
    const newPlan = await HostingPlan.create({
      planId: packageName,
      name: packageName,
      description: description || "",
      price: price || 0,
      currency: "INR", // Default
      features: features || [],
      directAdminPackage: packageName,
      quota: parseInt(quota) || 0,
      bandwidth: parseInt(bandwidth) || 0,
      isActive: true
    });

    return secureJsonResponse({ 
      success: true, 
      message: `Package '${packageName}' created successfully.`,
      data: newPlan 
    });
  } catch (error: any) {
    serverLogger.error(`Admin Package Creation Route Error (${request.headers.get('x-user-email')}):`, error.message);
    return secureErrorResponse(
      error.message || "Failed to create package",
      500,
      "PACKAGE_CREATION_FAILED",
      error // Pass original error object for internal logging
    );
  }
}

/**
 * PATCH /api/admin/hosting/packages
 * Updates an existing hosting package's metadata (price, description, etc.)
 * and synchronizes with Razorpay plans if renewal price changes.
 */
export async function PATCH(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    await connectToDatabase();
    const { id, name, description, price, renewalPrice, features, isActive } = await request.json();

    if (!id) {
      return secureErrorResponse("Package ID is required.", 400, "INVALID_INPUT");
    }

    const plan = await HostingPlan.findById(id);
    if (!plan) {
      return secureErrorResponse("Hosting plan not found.", 404, "NOT_FOUND");
    }

    // Check if renewal price changed
    const renewalPriceChanged = renewalPrice !== undefined && renewalPrice !== plan.renewalPrice;

    // Update fields
    if (name !== undefined) plan.name = name;
    if (description !== undefined) plan.description = description;
    if (price !== undefined) plan.price = price;
    if (renewalPrice !== undefined) plan.renewalPrice = renewalPrice;
    if (features !== undefined) plan.features = features;
    if (isActive !== undefined) plan.isActive = isActive;

    // If renewal price changed or plans don't exist, create/rotate Razorpay plans
    if (renewalPriceChanged || !plan.razorpayPlans?.monthly || !plan.razorpayPlans?.yearly) {
      try {
        const { RazorpayService } = await import("@/lib/razorpay");
        
        serverLogger.info(`[ADMIN-PRICE-UPDATE] Renewal price changed to ${plan.renewalPrice}. Creating new Razorpay plans for ${plan.name}`);

        // Create Monthly Plan
        const monthlyPlan = await RazorpayService.createPlan(
          `${plan.name} - Monthly`,
          `Renewal for ${plan.name}`,
          plan.renewalPrice,
          'monthly'
        );

        // Create Yearly Plan (Renewal price * 12)
        // Note: We might want to offer a discount for yearly, but for now we'll match current price logic
        const yearlyPlan = await RazorpayService.createPlan(
          `${plan.name} - Yearly`,
          `Annual Renewal for ${plan.name}`,
          plan.renewalPrice * 12,
          'yearly'
        );

        plan.razorpayPlans = {
          monthly: monthlyPlan.id,
          yearly: yearlyPlan.id
        };
        
        serverLogger.info(`[ADMIN-PRICE-UPDATE] Razorpay plans rotated: M=${monthlyPlan.id}, Y=${yearlyPlan.id}`);
      } catch (rzpErr: any) {
        serverLogger.error(`[ADMIN-PRICE-UPDATE] Failed to sync with Razorpay: ${rzpErr.message}`);
        // We still save the price update locally even if Razorpay fails, 
        // but it's a warning state.
      }
    }

    await plan.save();

    return secureJsonResponse({
      success: true,
      message: "Hosting package updated successfully.",
      data: plan
    });

  } catch (error: any) {
    serverLogger.error(`Admin Package Update Error:`, error.message);
    return secureErrorResponse(
      error.message || "Failed to update package",
      500,
      "UPDATE_FAILED"
    );
  }
}
