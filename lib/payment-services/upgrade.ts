import { NextResponse } from "next/server";
import { DirectAdminService } from "@/lib/directadmin";
import { RazorpayService } from "@/lib/razorpay";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import Hosting from "@/models/Hosting";
import HostingPlan from "@/models/HostingPlan";
import { serverLogger } from "@/lib/server-logger";

/**
 * Handles post-payment logic for hosting plan upgrades.
 * Called from the verify route when razorpay_order_id starts with "upg_".
 * Returns a NextResponse (early exit from the verify handler).
 */
export async function handleUpgradePayment(
  razorpay_order_id: string,
  razorpay_payment_id: string,
  razorpay_signature: string
): Promise<NextResponse> {
  await connectDB();

  const order = await Order.findOne({
    razorpayOrderId: razorpay_order_id,
    orderType: "hosting_upgrade",
  });

  if (!order) {
    serverLogger.error(`[UPGRADE] No upgrade order found for: ${razorpay_order_id}`);
    return NextResponse.json(
      { error: "Upgrade order not found" },
      { status: 404 }
    );
  }

  // Idempotency: already processed
  if (order.status !== "pending") {
    return NextResponse.json({
      success: true,
      message: "Upgrade already processed.",
      orderId: order.orderId,
    });
  }

  const { hostingId, fromPlanId, toPlanId } = order.upgradeDetails as {
    hostingId: string;
    fromPlanId: string;
    toPlanId: string;
    remainingDays: number;
  };

  const hosting = await Hosting.findById(hostingId);
  if (!hosting) {
    serverLogger.error(`[UPGRADE] Hosting not found: ${hostingId}`);
    order.status = "failed";
    await order.save();
    return NextResponse.json(
      { error: "Hosting account not found" },
      { status: 404 }
    );
  }

  const newPlan = await HostingPlan.findOne({ planId: toPlanId });
  if (!newPlan) {
    serverLogger.error(`[UPGRADE] Target hosting plan not found: ${toPlanId}`);
    order.status = "failed";
    await order.save();
    return NextResponse.json(
      { error: "Target plan not found" },
      { status: 404 }
    );
  }

  // Mark payment details on the order
  order.razorpayPaymentId = razorpay_payment_id;
  order.razorpaySignature = razorpay_signature;
  order.status = "paid";
  if (order.domains?.[0]) {
    order.domains[0].status = "processing";
  }

  // Cancel Razorpay subscription if one exists (upgrade switches billing to manual)
  if (hosting.subscriptionId) {
    try {
      await RazorpayService.cancelSubscription(hosting.subscriptionId);
      serverLogger.info(`[UPGRADE] Cancelled subscription: ...${hosting.subscriptionId.slice(-6)}`);
    } catch (subErr: any) {
      serverLogger.error(`[UPGRADE] Failed to cancel subscription ${hosting.subscriptionId}: ${subErr.message}`);
      // Non-fatal — proceed with DA change regardless
    }
    hosting.subscriptionId = undefined;
    hosting.billingType = "manual";
    hosting.autoRenew = false;
  }

  // Apply the new package on DirectAdmin
  try {
    await DirectAdminService.changePackage(hosting.directAdminUsername, newPlan.directAdminPackage);
    serverLogger.info(`[UPGRADE] DA package changed to ${newPlan.directAdminPackage} for ${hosting.directAdminUsername}`);
  } catch (daErr: any) {
    serverLogger.error(`[UPGRADE] DirectAdmin changePackage failed for ${hosting.directAdminUsername}: ${daErr.message}`);
    // Mark the order for admin review and return an error
    order.status = "paid" as any; // payment captured; flag via domains status
    if (order.domains?.[0]) {
      order.domains[0].status = "failed";
      order.domains[0].error = `DA package change failed: ${daErr.message}`;
    }
    await order.save();
    return NextResponse.json(
      {
        success: false,
        error: "Payment was captured but the plan change on the server failed. Our team has been notified and will resolve this shortly.",
        orderId: order.orderId,
      },
      { status: 500 }
    );
  }

  // Update Hosting document
  hosting.planId = newPlan.planId;
  hosting.name = newPlan.name;
  hosting.serverPackage = newPlan.directAdminPackage;
  await hosting.save();

  // Finalise order
  order.status = "completed";
  if (order.domains?.[0]) {
    order.domains[0].status = "registered";
  }
  await order.save();

  serverLogger.info(`[UPGRADE] Hosting ${hosting.domainName} upgraded from ${fromPlanId} to ${toPlanId}`);

  return NextResponse.json({
    success: true,
    message: "Hosting plan upgraded successfully.",
    orderId: order.orderId,
  });
}
