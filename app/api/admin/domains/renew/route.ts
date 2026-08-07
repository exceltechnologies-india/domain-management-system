import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { authorizeBillingCommandRequest } from "@/lib/integrations/billing-provision-auth";
import { renewDomain as rcRenewDomain } from "@/lib/integrations/resellerclub/renew-domain";
import { createOrder } from "@/lib/services/orders";
import { appendUserDomain, getUserByEmail } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";
import { Schemas } from "@/lib/validation";

export const dynamic = "force-dynamic";

const renewSchema = z.object({
  domainName: z.string().trim().min(1),
  years: z.number().int().min(1).max(10),
  userEmail: Schemas.email,
  /** Reference to whatever confirmed this is paid for (e.g. a Billing
   * invoice/quote id) — this endpoint executes the technical renewal, it
   * does not itself collect or verify payment. */
  paymentReference: z.string().trim().min(1).max(200),
});

/**
 * POST /api/admin/domains/renew
 *
 * Admin/Billing-triggered domain renewal — executes the real ResellerClub
 * renewal. Two auth paths, same convention as /api/admin/hosting/actions:
 * admin session OR a dedicated Billing command key (kept separate from the
 * provisioning/read-only Billing keys — this one triggers real
 * infrastructure spend, the highest-blast-radius capability in this
 * integration).
 *
 * Distinct from the self-service /api/domains/renew route: that one
 * collects a fresh Razorpay payment itself. This one assumes payment was
 * already confirmed elsewhere (a Billing invoice/quote) and just executes
 * the technical renewal + local record-keeping.
 */
export async function POST(request: NextRequest) {
  try {
    const isBillingCommand = authorizeBillingCommandRequest(request);
    if (!isBillingCommand) {
      const isAdmin = await AuthService.isAdmin(request);
      if (!isAdmin) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const validation = await validatedBody(request, renewSchema);
    if (!validation.ok) return validation.response;
    const { domainName, years, userEmail, paymentReference } = validation.data;

    const user = await getUserByEmail(userEmail);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const outcome = await rcRenewDomain({ domainName, years });

    if (outcome.kind === "balance_pending") {
      return NextResponse.json(
        { status: "pending", message: "Renewal queued — RC is completing it asynchronously." },
        { status: 202 }
      );
    }
    if (outcome.kind === "hard_failure") {
      serverLogger.error(`[admin-domain-renew] Failed for ${domainName}: ${outcome.reason}`);
      return NextResponse.json({ error: "Renewal failed at the registrar" }, { status: 502 });
    }

    const newExpiresAt = new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000);
    const renewedPrice = outcome.price ?? 0;

    const order = await createOrder({
      orderId: `RENEW_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      userId: user._id,
      userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
      userEmail: user.email,
      paymentId: paymentReference,
      amount: renewedPrice,
      currency: "INR",
      status: "completed",
      orderType: "renewal",
      domains: [
        {
          domainName,
          price: renewedPrice,
          currency: "INR",
          registrationPeriod: years,
          status: "registered",
          orderId: outcome.orderId,
          expiresAt: newExpiresAt,
        },
      ],
      successfulDomains: [domainName],
    });

    await appendUserDomain(String(user._id), {
      domainName,
      price: renewedPrice,
      currency: "INR",
      registrationPeriod: years,
      status: "registered",
      orderId: outcome.orderId,
      expiresAt: newExpiresAt,
    });

    return NextResponse.json({
      success: true,
      orderId: order.orderId,
      domainName,
      newExpiresAt,
    });
  } catch (error) {
    serverLogger.error("[admin-domain-renew] Unhandled error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
