import { NextRequest, NextResponse } from "next/server";
import { findPriorHostingOrderForUser } from "@/lib/services/orders";
import { findUserHosting, userHasAnyHosting } from "@/lib/services/hostings";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

const checkEligibilitySchema = z.object({
  domainName: z.string().trim().toLowerCase().min(3).max(253).optional(),
});

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
  // 1. Check if this user already has any hosting
  if (await userHasAnyHosting(userId)) {
    return {
      eligible: false,
      reason: "You already have an active or previous hosting account.",
    };
  }

  const previousOrder = await findPriorHostingOrderForUser(userId, email);

  if (previousOrder) {
    return {
      eligible: false,
      reason: "Your account is associated with a previous hosting purchase.",
    };
  }

  // 2. Check if this domain is already used for hosting — scoped to this user
  // (cross-user domain conflicts are enforced at creation time)
  if (domainName) {
    if (await findUserHosting(userId, { domainName })) {
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
      String(user._id),
      user.email,
      domainName
    );
    return secureJsonResponse(result);
  } catch (error: unknown) {
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

    const validation = await validatedBody(request, checkEligibilitySchema);
    if (!validation.ok) return validation.response;
    const domainName = validation.data.domainName ?? null;

    const result = await performEligibilityCheck(
      String(user._id),
      user.email,
      domainName
    );
    return secureJsonResponse(result);
  } catch (error: unknown) {
    serverLogger.error("Eligibility check error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
