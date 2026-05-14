import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Hosting from "@/models/Hosting";
import Order from "@/models/Order";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

/**
 * Shared eligibility check logic — scoped to the authenticated user.
 * Domain history queries are scoped to userId to prevent leaking whether
 * other users' domains exist in the system.
 */
async function performEligibilityCheck(
  userId: string,
  email: string,
  domainName: string | null
) {
  await connectDB();

  // 1. Check if this user already has any hosting
  const existingHosting = await Hosting.findOne({ userId });
  if (existingHosting) {
    return {
      eligible: false,
      reason: "You already have an active or previous hosting account.",
    };
  }

  const previousOrder = await Order.findOne({
    $or: [{ userEmail: email }, { userId }],
    "domains.itemType": "hosting",
    status: { $in: ["paid", "completed", "processing"] },
  });

  if (previousOrder) {
    return {
      eligible: false,
      reason: "Your account is associated with a previous hosting purchase.",
    };
  }

  // 2. Check if this domain is already used for hosting — scoped to this user
  // (cross-user domain conflicts are enforced at creation time)
  if (domainName) {
    const domainHosting = await Hosting.findOne({ domainName, userId });
    if (domainHosting) {
      return {
        eligible: false,
        reason: "This domain already has hosting under your account.",
      };
    }
  }

  return { eligible: true };
}

/**
 * GET /api/user/hosting/check-eligibility?domainName=<name>
 */
export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const { searchParams } = new URL(request.url);
    const domainName = searchParams.get("domainName")?.toLowerCase() || null;

    const result = await performEligibilityCheck(
      (user._id as any).toString(),
      user.email,
      domainName
    );
    return secureJsonResponse(result);
  } catch (error: any) {
    serverLogger.error("Eligibility check error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/user/hosting/check-eligibility
 */
export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const body = await request.json();
    const domainName = body.domainName?.toLowerCase() || null;

    const result = await performEligibilityCheck(
      (user._id as any).toString(),
      user.email,
      domainName
    );
    return secureJsonResponse(result);
  } catch (error: any) {
    serverLogger.error("Eligibility check error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
