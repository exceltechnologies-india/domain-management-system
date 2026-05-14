import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Hosting from "@/models/Hosting";
import HostingPlan from "@/models/HostingPlan";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

/**
 * GET /api/user/hosting/renew-info
 * 
 * Fetches renewal information for a hosting account.
 * Restricted to 1-year (12 months) renewal only as per business rules.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const { searchParams } = new URL(request.url);
    const domainName = searchParams.get("domainName");

    if (!domainName) {
      return secureErrorResponse("Domain name is required", 400, "INVALID_PARAM");
    }

    await connectDB();

    const hosting = await Hosting.findOne({ 
      userId: user._id, 
      domainName: domainName.toLowerCase() 
    });

    if (!hosting) {
      return secureErrorResponse("Hosting account not found", 404, "NOT_FOUND");
    }

    const plan = await HostingPlan.findOne({ planId: hosting.planId });
    if (!plan) {
      return secureErrorResponse("Hosting plan details not found", 404, "PLAN_NOT_FOUND");
    }

    // Business Rule: Renewals are only for 1 year (12 months)
    const renewalYears = 1;
    const renewalMonths = 12;
    const price = plan.price * renewalMonths;

    return secureJsonResponse({
      success: true,
      data: {
        domainName: hosting.domainName,
        currentStatus: hosting.status,
        currentExpiry: hosting.expiryDate,
        planName: plan.name,
        renewalPricing: {
          price: price,
          currency: plan.currency || "INR",
          periodMonths: renewalMonths,
          periodYears: renewalYears
        }
      }
    });

  } catch (error: any) {
    serverLogger.error("Hosting renewal info error:", error);
    return secureErrorResponse("Failed to get renewal info", 500, "INTERNAL_ERROR");
  }
}
