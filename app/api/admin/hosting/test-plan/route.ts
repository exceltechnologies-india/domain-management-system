import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import { getSettingValue, upsertSetting } from "@/lib/services/settings";
import { RazorpayService } from "@/lib/razorpay";
import {
  getPlanByPlanIdLean,
  setPlanActive,
  upsertPlanByPlanId,
} from "@/lib/services/hosting-plans";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

const TEST_PLAN_ID = "test_1rs";
const TEST_PLAN_DA_PACKAGE = "Starter"; // reuse smallest DA package

async function getAdminName(request: NextRequest): Promise<string> {
  const admin = await AuthService.getUserFromRequest(request);
  return admin ? `${admin.firstName} ${admin.lastName}`.trim() : "admin";
}

// ── GET /api/admin/hosting/test-plan ──────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) return secureErrorResponse("Forbidden", 403, "FORBIDDEN");

    await connectDB();

    const plan = await getPlanByPlanIdLean(TEST_PLAN_ID);
    const enabled = await getSettingValue<boolean>("hosting_test_plan_enabled", false);

    return secureJsonResponse({
      enabled: enabled === true,
      plan: plan ?? null,
    });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}

// ── POST /api/admin/hosting/test-plan ─────────────────────────────────────
// Body: { action: 'enable' | 'disable', razorpayPlanMonthly?: string }
export async function POST(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) return secureErrorResponse("Forbidden", 403, "FORBIDDEN");

    const adminName = await getAdminName(request);
    const body = await request.json();
    const { action, razorpayPlanMonthly } = body;

    if (!["enable", "disable"].includes(action)) {
      return secureErrorResponse("action must be 'enable' or 'disable'", 400, "VALIDATION_ERROR");
    }

    if (action === "disable") {
      await setPlanActive(TEST_PLAN_ID, false);

      await upsertSetting("hosting_test_plan_enabled", false, {
        description: "Show ₹1 test hosting plan on the public hosting page",
        category: "promotions",
        updatedBy: adminName,
      });

      serverLogger.info(`[TestPlan] Disabled by ${adminName}`);
      return secureJsonResponse({ success: true, enabled: false });
    }

    // action === 'enable'
    let rzpPlanMonthlyId = razorpayPlanMonthly?.trim() || "";

    // If no Razorpay plan ID supplied, try to get from DB first, then auto-create
    if (!rzpPlanMonthlyId) {
      const existing = await getPlanByPlanIdLean(TEST_PLAN_ID);
      rzpPlanMonthlyId = existing?.razorpayPlans?.monthly || "";
    }

    if (!rzpPlanMonthlyId) {
      try {
        const rzpPlan = await RazorpayService.createPlan(
          "₹1 Test Hosting Plan",
          "1-rupee live payment test plan",
          1,
          "monthly"
        );
        rzpPlanMonthlyId = rzpPlan.id;
        serverLogger.info(`[TestPlan] Created Razorpay plan: ${rzpPlanMonthlyId}`);
      } catch (err: any) {
        serverLogger.error(`[TestPlan] Razorpay plan creation failed: ${err.message}`);
        return secureErrorResponse(
          `Failed to create Razorpay plan: ${err.message}`,
          500,
          "RAZORPAY_ERROR"
        );
      }
    }

    // Upsert the HostingPlan record
    const plan = await upsertPlanByPlanId(TEST_PLAN_ID, {
      name: "₹1 Test Plan",
      description: "Live payment test — ₹1/month",
      price: 1,
      renewalPrice: 1,
      currency: "INR",
      features: ["1 Website", "Test Only — Not for Production Use"],
      directAdminPackage: TEST_PLAN_DA_PACKAGE,
      quota: 10000,
      bandwidth: 100000,
      isActive: true,
      isTestPlan: true,
      "razorpayPlans.monthly": rzpPlanMonthlyId,
    });

    await upsertSetting("hosting_test_plan_enabled", true, {
      description: "Show ₹1 test hosting plan on the public hosting page",
      category: "promotions",
      updatedBy: adminName,
    });

    serverLogger.info(`[TestPlan] Enabled by ${adminName} — Razorpay: ${rzpPlanMonthlyId}`);

    return secureJsonResponse({
      success: true,
      enabled: true,
      plan,
      razorpayPlanMonthly: rzpPlanMonthlyId,
    });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
