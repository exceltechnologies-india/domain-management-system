import { NextRequest } from "next/server";
import { findUserHosting } from "@/lib/services/hostings";
import { getPlanByPlanId, listActivePlans } from "@/lib/services/hosting-plans";
import { perMonthRate, upgradeCharge } from "@/lib/pricing/hosting-price";
import { fetchHostingPrices, HOSTING_PRICES_UNAVAILABLE } from "@/lib/reselleros/hosting-prices";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

/**
 * GET /api/user/hosting/upgrade-info?domainName=<domain>
 *
 * Returns eligible upgrade plans with prorated charges for the given hosting account.
 * Prorated formula: round((targetPrice - currentPrice) * remainingDays / 30), min ₹100.
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
      return secureErrorResponse("domainName is required", 400, "INVALID_PARAM");
    }

    const hosting = await findUserHosting(String(user._id), {
      domainName: domainName.toLowerCase(),
    });

    if (!hosting) {
      return secureErrorResponse("Hosting account not found", 404, "NOT_FOUND");
    }

    if (hosting.status !== 'active') {
      return secureErrorResponse(
        "Only active hosting accounts can be upgraded",
        400,
        "NOT_ELIGIBLE"
      );
    }

    const remainingDays = Math.ceil(
      (hosting.expiryDate.getTime() - Date.now()) / 86_400_000
    );

    if (remainingDays <= 0) {
      return secureErrorResponse(
        "Hosting has expired. Please renew before upgrading.",
        400,
        "HOSTING_EXPIRED"
      );
    }

    const currentPlan = await getPlanByPlanId(hosting.planId);
    if (!currentPlan) {
      return secureErrorResponse("Current plan details not found", 404, "PLAN_NOT_FOUND");
    }

    const allPlans = await listActivePlans();

    // ResellerOS's live prices (owner, 28 Sep 2026). No table, no quote — never a copied figure.
    const prices = await fetchHostingPrices();
    if (!prices.ok) {
      serverLogger.error(`[UPGRADE-INFO] hosting prices unavailable: ${prices.detail}`);
      return secureErrorResponse(HOSTING_PRICES_UNAVAILABLE, 503, "PRICES_UNAVAILABLE");
    }
    const table = prices.table;

    // Quoted exactly as api/user/hosting/upgrade charges — ResellerOS's
    // prices (lib/pricing/hosting-price.ts). A plan with no ResellerOS price
    // is not offered, rather than quoted at the disregarded DMS figure.
    const eligiblePlans = allPlans
      .map((plan) => ({ plan, upgrade: upgradeCharge(table, currentPlan.planId, plan.planId, remainingDays) }))
      .filter((x): x is { plan: typeof x.plan; upgrade: { ok: true; amount: number } } => x.upgrade.ok)
      .map(({ plan, upgrade }) => {
        const chargeAmount = upgrade.amount;
        return {
          planId: plan.planId,
          name: plan.name,
          description: plan.description,
          // Known: upgradeCharge above only passes plans ResellerOS prices.
          price: perMonthRate(table, plan.planId) as number,
          currency: plan.currency || "INR",
          features: plan.features,
          quota: plan.quota,
          bandwidth: plan.bandwidth,
          chargeAmount,
          remainingDays,
        };
      });

    return secureJsonResponse({
      success: true,
      data: {
        currentPlan: {
          planId: currentPlan.planId,
          name: currentPlan.name,
          price: perMonthRate(table, currentPlan.planId),
        },
        eligiblePlans,
        remainingDays,
        hasSubscription: !!hosting.subscriptionId,
        expiryDate: hosting.expiryDate,
      },
    });
  } catch (error: unknown) {
    serverLogger.error("[UPGRADE-INFO] Error:", error instanceof Error ? error.message : error);
    return secureErrorResponse("Failed to get upgrade info", 500, "INTERNAL_ERROR");
  }
}
