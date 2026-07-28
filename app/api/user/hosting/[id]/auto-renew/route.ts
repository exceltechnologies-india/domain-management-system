import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { findUserHostingById } from "@/lib/services/hostings";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

const autoRenewSchema = z.object({
  autoRenew: z.boolean(),
});

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, autoRenewSchema);
    if (!validation.ok) return validation.response;
    const { autoRenew } = validation.data;

    const hosting = await findUserHostingById(id, user._id);
    if (!hosting) {
      return NextResponse.json({ error: "Hosting not found" }, { status: 404 });
    }

    if (hosting.status !== "active") {
      return NextResponse.json(
        { error: "Auto-renewal can only be changed on active hosting" },
        { status: 400 }
      );
    }

    // Auto-renewal is MANDATORY for mandate-billed (subscription / tokens)
    // plans — the saved Razorpay mandate renews them automatically and the UI
    // shows it as a locked "on". Reject any attempt to turn it off (the UI no
    // longer offers the toggle, so this defends against a direct API call). To
    // stop future billing the customer cancels the plan, not auto-renew.
    if (autoRenew === false && hosting.billingType === "subscription") {
      return NextResponse.json(
        {
          error:
            "Auto-renewal is required for this plan and can't be turned off. To stop future billing, cancel the plan (contact support).",
        },
        { status: 400 }
      );
    }

    hosting.autoRenew = autoRenew;
    await hosting.save();

    serverLogger.info(
      `[AutoRenew] ${user.email} set autoRenew=${autoRenew} for ${hosting.domainName}`
    );

    return NextResponse.json({
      success: true,
      autoRenew: hosting.autoRenew,
      billingType: hosting.billingType,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[AutoRenew] Error:", message);
    return NextResponse.json({ error: "Failed to update auto-renewal" }, { status: 500 });
  }
}
