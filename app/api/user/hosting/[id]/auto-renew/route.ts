import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { findUserHostingById } from "@/lib/services/hostings";
import { serverLogger } from "@/lib/server-logger";

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

    const body = await request.json();
    if (typeof body.autoRenew !== "boolean") {
      return NextResponse.json({ error: "autoRenew must be a boolean" }, { status: 400 });
    }

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

    hosting.autoRenew = body.autoRenew;
    await hosting.save();

    serverLogger.info(
      `[AutoRenew] ${user.email} set autoRenew=${body.autoRenew} for ${hosting.domainName}`
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
