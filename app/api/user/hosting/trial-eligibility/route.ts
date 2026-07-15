import { NextRequest, NextResponse } from "next/server";
import { userHasPriorTrialOrder } from "@/lib/services/orders";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { getSettingValue } from "@/lib/services/settings";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import {
  evaluateTrialAbuse,
  getClientIp,
  hashIp,
} from "@/lib/trial-abuse";
import { validatedBody, z } from "@/lib/api-validation";

export const dynamic = "force-dynamic";

const eligibilitySchema = z.object({
  planId: z.string().optional(),
  deviceFingerprint: z.string().optional(),
  recaptchaToken: z.string().nullable().optional(),
});

type EligibilityBody = z.infer<typeof eligibilitySchema>;

/**
 * GET (legacy) / POST /api/user/hosting/trial-eligibility
 *
 * GET keeps the original ?planId=<id> contract for any older clients still
 * cached on user devices. POST is the canonical form — accepts the abuse
 * signals (deviceFingerprint) in the body so they're not in the URL or referer.
 */
async function runEligibility(
  request: NextRequest,
  body: EligibilityBody
): Promise<NextResponse> {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

  // 1. Global trials kill-switch
  const trialEnabled = await getSettingValue<boolean>("hosting_trial_enabled", true);
  const trialsEnabled = trialEnabled !== false;
  if (!trialsEnabled) {
    return secureJsonResponse({ eligible: false, reason: "Trials are currently unavailable" });
  }

  // 2. One trial per user lifetime
  const userId = String(user._id);
  const priorTrial = await userHasPriorTrialOrder(userId);
  if (priorTrial) {
    return secureJsonResponse({ eligible: false, reason: "You have already used your free trial" });
  }

  // 3. Abuse defenses — disposable email, reCAPTCHA, IP & device throttles.
  const clientIp = getClientIp(request);
  const abuseCheck = await evaluateTrialAbuse(
    {
      email: user.email,
      ipHash: hashIp(clientIp),
      deviceFingerprint: body.deviceFingerprint,
    },
    { clientIp, recaptchaToken: body.recaptchaToken || undefined }
  );
  if (!abuseCheck.allowed) {
    serverLogger.warn(
      `[TrialEligibility] Blocked for user=${user.email} reason=${abuseCheck.code}`
    );
    return secureJsonResponse({
      eligible: false,
      reason: abuseCheck.reason,
      code: abuseCheck.code,
    });
  }

  // 4. Confirm requested plan exists. The Razorpay-yearly-plan check
  //    only applies under the Subscriptions flow — Tokens flow uses CIT
  //    auth (no pre-configured plan needed) and Manual flow bypasses
  //    Razorpay entirely. Pre-2026-06-29 this check ran regardless of
  //    flow, which blocked trial signup on the day the operator flipped
  //    HOSTING_MANDATE_FLOW=manual — every customer hitting "Start Free
  //    Trial" on the live Starter plan got "This plan is not available
  //    for a free trial" because the gate didn't know about the
  //    non-Subscriptions flows.
  if (body.planId) {
    const plan = await getPlanByPlanId(body.planId);
    if (!plan) {
      return secureJsonResponse({ eligible: false, reason: "This plan is not available for a free trial" });
    }
    const mandateMode = process.env.HOSTING_MANDATE_FLOW ?? "subscriptions";
    if (mandateMode === "subscriptions" && !plan.razorpayPlans?.yearly) {
      return secureJsonResponse({ eligible: false, reason: "This plan is not available for a free trial" });
    }
  }

  return secureJsonResponse({
    eligible: true,
    trialDays: 15,
  });
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    return await runEligibility(request, {
      planId: searchParams.get("planId") || undefined,
    });
  } catch (error: unknown) {
    serverLogger.error("Trial eligibility check error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const validation = await validatedBody(request, eligibilitySchema);
    if (!validation.ok) return validation.response;
    return await runEligibility(request, validation.data);
  } catch (error: unknown) {
    serverLogger.error("Trial eligibility check error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
