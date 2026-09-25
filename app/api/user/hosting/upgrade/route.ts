import { NextRequest } from "next/server";
import { findUserHosting } from "@/lib/services/hostings";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { upgradeCharge } from "@/lib/pricing/hosting-price";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";
import { sendUpgradeRequest, upgradeRequestRefusalMessage } from "@/lib/reselleros/upgrade-request";

const upgradeSchema = z.object({
  domainName: z.string().trim().toLowerCase().min(3).max(253),
  targetPlanId: z.string().min(1),
});

export const dynamic = 'force-dynamic';

/**
 * POST /api/user/hosting/upgrade — REQUEST a plan upgrade, billed by ResellerOS.
 * Body: { domainName, targetPlanId }
 *
 * Owner decision, 25 Sep 2026 ("Request, billed by ResellerOS"). Until then
 * this created a Razorpay order on DMS's account and a pending Order, and
 * /api/payments/verify changed the plan once paid. Now it creates NOTHING in
 * DMS and takes no payment: it sends the request to ResellerOS
 * (lib/reselleros/upgrade-request.ts), whose staff send a quote; the plan is
 * changed after that quote is paid.
 *
 * Identity (email, name, phone, account id) comes from the session. The
 * prorated amount is computed HERE, on ResellerOS's prices, and sent only as
 * `estimateRupees` — the quote is the price. Not retried: a timed-out request
 * may have been recorded.
 *
 * ResellerOS refusing our key is answered 503, never 401 (lib/api-client.ts
 * reads a 401 as "signed out").
 */
export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const rl = await rateLimiters.hostingRenewUpgrade.checkKey(`hosting_upgrade:${user._id}`);
    if (!rl.allowed) {
      return rateLimitResponse(rl, {
        limit: 5,
        message: "Too many upgrade requests. Please wait a minute and try again.",
      });
    }

    const validation = await validatedBody(request, upgradeSchema);
    if (!validation.ok) return validation.response;
    const { domainName, targetPlanId } = validation.data;

    const hosting = await findUserHosting(String(user._id), { domainName });
    if (!hosting) {
      return secureErrorResponse("Hosting account not found", 404, "NOT_FOUND");
    }
    if (hosting.status !== 'active') {
      return secureErrorResponse("Only active hosting accounts can be upgraded", 400, "NOT_ELIGIBLE");
    }
    const remainingDays = Math.ceil((hosting.expiryDate.getTime() - Date.now()) / 86_400_000);
    if (remainingDays <= 0) {
      return secureErrorResponse("Hosting has expired. Please renew before upgrading.", 400, "HOSTING_EXPIRED");
    }

    const currentPlan = await getPlanByPlanId(hosting.planId);
    if (!currentPlan) {
      return secureErrorResponse("Current plan details not found", 404, "PLAN_NOT_FOUND");
    }
    const targetPlan = await getPlanByPlanId(targetPlanId, { activeOnly: true });
    if (!targetPlan) {
      return secureErrorResponse("Target plan not found", 404, "TARGET_PLAN_NOT_FOUND");
    }

    const upgrade = upgradeCharge(currentPlan.planId, targetPlan.planId, remainingDays);
    if (!upgrade.ok && upgrade.reason === "not-higher") {
      return secureErrorResponse(
        "Target plan must have a higher price than the current plan",
        400,
        "INVALID_UPGRADE"
      );
    }
    // A plan ResellerOS does not price gets no estimate — the request still
    // goes, and staff quote it. Never an invented figure.
    const estimateRupees = upgrade.ok ? Math.round(upgrade.amount) : undefined;

    const fullName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.replace(/\s+/g, " ").trim() || user.email;
    const phone = (user.phone ?? "").replace(/[\s-]/g, "");
    const outcome = await sendUpgradeRequest({
      dmsUserId: String(user._id),
      email: user.email,
      fullName,
      ...(phone.length >= 10 && phone.length <= 20 ? { phone } : {}),
      ...(user.companyName ? { companyName: user.companyName } : {}),
      domain: domainName,
      currentPlan: currentPlan.planId,
      targetPlan: targetPlan.planId,
      ...(estimateRupees !== undefined ? { estimateRupees } : {}),
      expiresAt: hosting.expiryDate.toISOString(),
    });

    if (outcome.kind === "ok") {
      serverLogger.info(
        `[UPGRADE-REQUEST] ${domainName}: ${currentPlan.planId} -> ${targetPlan.planId} sent to ResellerOS ` +
          `(lead ${outcome.leadId ?? "?"}, alreadyRequested=${outcome.alreadyRequested})`
      );
      return secureJsonResponse({
        success: true,
        data: {
          leadId: outcome.leadId,
          alreadyRequested: outcome.alreadyRequested,
          estimateRupees: estimateRupees ?? null,
          targetPlanName: targetPlan.name,
        },
      });
    }

    const message = upgradeRequestRefusalMessage(outcome);
    switch (outcome.kind) {
      case "refused":
        serverLogger.warn(`[UPGRADE-REQUEST] ResellerOS refused ${domainName}: ${outcome.message}`);
        return secureJsonResponse({ error: message, code: "UPGRADE_REQUEST_REFUSED" }, 400);
      case "failed":
        serverLogger.error(`[UPGRADE-REQUEST] ResellerOS failed for ${domainName}: ${outcome.message}`);
        return secureJsonResponse({ error: message, code: "UPGRADE_REQUEST_FAILED" }, 503);
      case "not_configured":
        serverLogger.error(`[UPGRADE-REQUEST] not configured — set ${outcome.missing.join(" and ")} on DMS.`);
        return secureJsonResponse({ error: message, code: "UPGRADE_REQUEST_NOT_CONFIGURED" }, 503);
      case "config":
        serverLogger.error(
          `[UPGRADE-REQUEST] ResellerOS refused DMS's panel key or is not configured (HTTP ${outcome.status}: ${outcome.detail}).`
        );
        return secureJsonResponse({ error: message, code: "UPGRADE_REQUEST_UNAVAILABLE" }, 503);
      case "unreachable":
        serverLogger.error(
          `[UPGRADE-REQUEST] no usable answer for ${domainName} (${outcome.detail}); mayHaveRecorded=${outcome.mayHaveRecorded}. Not retried.`
        );
        return secureJsonResponse(
          { error: message, code: "RESELLEROS_UNREACHABLE", mayHaveRecorded: outcome.mayHaveRecorded },
          503
        );
    }
  } catch (error: unknown) {
    serverLogger.error("[UPGRADE-REQUEST] Error:", error instanceof Error ? error.message : error);
    return secureErrorResponse("Failed to send the upgrade request", 500, "INTERNAL_ERROR");
  }
}
