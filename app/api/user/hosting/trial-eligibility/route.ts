import { NextRequest, NextResponse } from "next/server";
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
import { isTrialPlan, TRIAL_PLAN_REFUSAL } from "@/lib/pricing/trial-plan";
import { isProvisionableDomain } from "@/lib/validation/hosting-domain";
import { checkTrialEligibility, CANNOT_CHECK_TRIAL_MESSAGE } from "@/lib/reselleros/trial-eligibility";

export const dynamic = "force-dynamic";

const eligibilitySchema = z.object({
  planId: z.string().optional(),
  /** Optional: the domain the trial is for, sent to ResellerOS only when it is a real name. */
  domain: z.string().max(253).optional(),
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
 *
 * WHO DECIDES (owner, 26 Sep 2026: "Ask ResellerOS instead"): whether this
 * customer has had a trial is answered by ResellerOS
 * (lib/reselleros/trial-eligibility.ts), which runs the same check its
 * startHostingTrial uses — the same place the trial is actually started — so
 * the pre-check and the checkout cannot disagree. DMS no longer consults its
 * own trial history here. When ResellerOS cannot answer (unreachable, timeout,
 * its history unreadable, key missing) the answer is "we can't check right
 * now", never eligible and never DMS's own verdict. What stays in DMS is what
 * ResellerOS cannot see: the trials switch, the trial-abuse checks (IP /
 * device / reCAPTCHA) and the Starter-only rule.
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

  // 2. One trial per customer, across BOTH apps — ResellerOS's answer.
  // Identity comes only from the session.
  const domain = (body.domain ?? "").trim().toLowerCase();
  const verdict = await checkTrialEligibility({
    email: user.email,
    ...(user.phone ? { phone: user.phone } : {}),
    ...(isProvisionableDomain(domain) ? { domain } : {}),
  });
  if (verdict.kind === "not_eligible") {
    return secureJsonResponse({ eligible: false, reason: verdict.reason });
  }
  if (verdict.kind === "cannot_check") {
    serverLogger.error(`[TrialEligibility] ResellerOS could not answer for ${user.email}: ${verdict.detail}`);
    return secureJsonResponse({ eligible: false, reason: CANNOT_CHECK_TRIAL_MESSAGE, code: "CANNOT_CHECK" });
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

  // 4. Starter only (lib/pricing/trial-plan.ts), and the plan must exist.
  // (The old "Razorpay yearly plan configured" check went with DMS's
  // subscriptions: a trial now starts in ResellerOS and needs no DMS plan.)
  if (body.planId) {
    if (!isTrialPlan(body.planId)) {
      return secureJsonResponse({ eligible: false, reason: TRIAL_PLAN_REFUSAL });
    }
    const plan = await getPlanByPlanId(body.planId);
    if (!plan) {
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
