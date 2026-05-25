import { NextResponse } from "next/server";
import { changePackage as daChangePackage } from "@/lib/integrations/directadmin";
import { RazorpayService } from "@/lib/razorpay";
import { getOrderByRazorpayOrderId } from "@/lib/services/orders";
import { getHostingById } from "@/lib/services/hostings";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { serverLogger } from "@/lib/server-logger";
import type { IOrder } from "@/models/Order";

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
  const order = await getOrderByRazorpayOrderId(razorpay_order_id, {
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

  const hosting = await getHostingById(hostingId);
  if (!hosting) {
    serverLogger.error(`[UPGRADE] Hosting not found: ${hostingId}`);
    order.status = "failed";
    await order.save();
    return NextResponse.json(
      { error: "Hosting account not found" },
      { status: 404 }
    );
  }

  const newPlan = await getPlanByPlanId(toPlanId);
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
    } catch (subErr: unknown) {
      const message = subErr instanceof Error ? subErr.message : String(subErr);
      serverLogger.error(`[UPGRADE] Failed to cancel subscription ${hosting.subscriptionId}: ${message}`);
      // Non-fatal — proceed with DA change regardless
    }
    hosting.subscriptionId = undefined;
    hosting.billingType = "manual";
    hosting.autoRenew = false;
  }

  const daOutcome = await daChangePackage({
    username: hosting.directAdminUsername,
    newPackage: newPlan.directAdminPackage,
  });

  if (daOutcome.kind !== "changed") {
    // `paid` isn't in IOrder['status']'s enum (the schema accepts it but the
    // type doesn't surface it); narrow at the assignment to avoid widening
    // the model just for this rare path.
    order.status = "paid" as IOrder["status"];
    if (order.domains?.[0]) {
      order.domains[0].status = "failed";
      order.domains[0].error = `DA package change ${daOutcome.kind}: ${daOutcome.reason}`;
    }
    await order.save();
    serverLogger.error(
      `[UPGRADE] changePackage ${daOutcome.kind} for ${hosting.directAdminUsername}: ${daOutcome.reason}`
    );
    return NextResponse.json(
      {
        success: false,
        error: "Payment was captured but the plan change on the server failed. Our team has been notified and will resolve this shortly.",
        orderId: order.orderId,
      },
      { status: 500 }
    );
  }
  serverLogger.info(
    `[UPGRADE] DA package changed to ${newPlan.directAdminPackage} for ${hosting.directAdminUsername}`
  );

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
