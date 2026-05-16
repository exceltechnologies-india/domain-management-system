import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import HostingPlan from "@/models/HostingPlan";
import { getSettingValue } from "@/lib/services/settings";

export const dynamic = "force-dynamic";

/**
 * GET /api/public/hosting-test-plan
 * Returns whether the ₹1 test plan is enabled and its details.
 * Public — no auth required.
 */
export async function GET(_request: NextRequest) {
  try {
    await connectDB();

    const enabled = await getSettingValue<boolean>("hosting_test_plan_enabled", false);
    if (enabled !== true) {
      return NextResponse.json({ enabled: false });
    }

    const plan = await HostingPlan.findOne({ planId: "test_1rs", isActive: true }).lean() as any;
    if (!plan) {
      return NextResponse.json({ enabled: false });
    }

    return NextResponse.json({
      enabled: true,
      plan: {
        id: plan.planId,
        name: plan.name,
        description: plan.description,
        price: plan.price,
        currency: plan.currency,
        features: plan.features,
        serverPackage: plan.directAdminPackage,
        razorpayPlanMonthly: plan.razorpayPlans?.monthly,
      },
    });
  } catch {
    return NextResponse.json({ enabled: false });
  }
}
