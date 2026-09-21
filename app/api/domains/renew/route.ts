/**
 * Customer-initiated domain renewal.
 *
 * POST spends real money — `rcRenewDomain` debits the reseller balance at
 * the registrar — so it carries two gates that were both missing:
 *
 *  1. **Ownership.** The domain must sit on an order belonging to the
 *     caller. Without this any signed-in customer could renew any domain in
 *     the reseller account. Uses the repo-wide pair
 *     (`findOrderByDomainForUser` + `findOrderDomain`), the same as
 *     domains/dns and domains/verify-status, so "not yours" and "not there"
 *     are indistinguishable from outside.
 *
 *  2. **A real payment.** The body used to carry a free-text `paymentId`
 *     that nothing verified, and the only caller FABRICATED it
 *     (`renew_${Date.now()}_…`, commented "mock payment ID for testing")
 *     because no Razorpay checkout was ever built for renewal. Every
 *     renewal was therefore on the house. It now takes the same Razorpay
 *     fields as every other money path here and runs them through
 *     `verifyRazorpayPayment` — real, captured, bound to the claimed order —
 *     plus a replay check, all BEFORE the registrar is touched.
 *
 * What is deliberately NOT built here: the checkout half. There is no
 * retail renewal price for domains anywhere in this codebase — `renewalPrice`
 * is a HostingPlan field, and `getRenewalPricing` returns the REGISTRAR's
 * cost, not what a customer pays. Inventing a markup would put a made-up
 * figure on a real charge. Until an operator sets domain renewal pricing and
 * a create-order step exists (mirror `app/api/user/hosting/renew`), a
 * customer has no payment to present and this route refuses before spending.
 *
 * Refusing costs nothing, because this route has never completed a renewal:
 * `razorpayOrderId`/`razorpayPaymentId` have been `required: true` on the
 * Order schema since the initial commit and the createOrder call below never
 * passed them, so it threw a ValidationError into the catch on every run —
 * AFTER the registrar had already been charged. Same shape the
 * `razorpaySignature` comment in models/Order.ts records for 2026-09-04.
 * Both ids are now passed.
 */
import { NextRequest, NextResponse } from "next/server";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { renewDomain as rcRenewDomain } from "@/lib/integrations/resellerclub";
import { AuthService } from "@/lib/auth";
import {
  createOrder,
  findOrderByDomainForUser,
  findOrderDomain,
  getOrderByRazorpayPaymentId,
} from "@/lib/services/orders";
import { verifyRazorpayPayment } from "@/lib/services/payment/verification";
import { appendUserDomain } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, validatedQuery, z } from "@/lib/api-validation";

const domainRenewQuerySchema = z.object({
  domainName: z.string().trim().toLowerCase().min(3).max(253),
  years: z.coerce.number().int().positive().max(10).default(1),
});

const domainRenewBodySchema = z.object({
  domainName: z.string().trim().toLowerCase().min(3).max(253),
  years: z.number().int().positive().max(10),
  /**
   * Razorpay ids, not a free-text string. `razorpay_signature` is optional
   * for the reason verification.ts documents — the Tokens/mandate flow
   * returns none — and the server-side checks (payment is real, captured,
   * order_id matches) stand without it.
   */
  razorpay_order_id: z.string().min(1, "Razorpay order ID is required"),
  razorpay_payment_id: z.string().min(1, "Razorpay payment ID is required"),
  razorpay_signature: z.string().min(1).optional(),
});

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = validatedQuery(request, domainRenewQuerySchema);
    if (!validation.ok) return validation.response;
    const { domainName, years } = validation.data;

    /**
     * Same ownership gate as POST. This verb spends no money, but it does
     * answer "is this domain in the reseller account, and when does it
     * expire" for any string a signed-in user cares to send — and the
     * pricing error below is forwarded verbatim from ResellerClub, whose
     * message for a stranger's domain is "Domain not in your reseller
     * account". domains/dns gates GET for the same reason.
     */
    const ownerOrder = await findOrderByDomainForUser(user._id, domainName);
    if (!ownerOrder || !findOrderDomain(ownerOrder, domainName)) {
      return NextResponse.json(
        {
          error:
            "We could not find that domain on your account. If you believe it is yours, contact support and we will check it for you.",
        },
        { status: 404 }
      );
    }

    // Get renewal pricing
    const pricingResult = await ResellerClubAPI.getRenewalPricing(
      domainName,
      years
    );

    if (pricingResult.status === "error") {
      return NextResponse.json(
        { error: pricingResult.message },
        { status: 500 }
      );
    }

    // Get domain expiry date
    const expiryResult = await ResellerClubAPI.getDomainExpiry(domainName);

    return NextResponse.json({
      success: true,
      domainName,
      years,
      pricing: pricingResult.data,
      expiry: expiryResult.data,
    });
  } catch (error) {
    serverLogger.error("Domain renewal info error:", error);
    return NextResponse.json(
      { error: "Failed to get domain renewal information" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, domainRenewBodySchema);
    if (!validation.ok) return validation.response;
    const {
      domainName,
      years,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = validation.data;

    /**
     * Gate 1 — ownership. Before anything that costs money.
     *
     * 404 rather than 403 on purpose: the repo convention
     * (findOrderByDomainForUser's own docstring) is that "no such domain"
     * and "somebody else's domain" must look identical, so this cannot be
     * used to probe which domains the reseller holds.
     */
    const ownerOrder = await findOrderByDomainForUser(user._id, domainName);
    if (!ownerOrder || !findOrderDomain(ownerOrder, domainName)) {
      serverLogger.warn(
        `[renew] ownership refused: user ${String(user._id)} asked to renew ${domainName}`
      );
      return NextResponse.json(
        {
          error:
            "We could not find that domain on your account. If you believe it is yours, contact support and we will check it for you.",
        },
        { status: 404 }
      );
    }

    /**
     * Gate 2 — the payment is real. Also before anything that costs money.
     *
     * verifyRazorpayPayment hands back a ready NextResponse on failure, with
     * the same statuses and messages as /api/payments/verify, so a renewal
     * failure reads the same as any other payment failure here.
     */
    const payment = await verifyRazorpayPayment({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });
    if (!payment.ok) return payment.response;

    /**
     * ...and it has not already been spent. Without this, one captured
     * payment could be replayed to renew the same domain repeatedly — the
     * charge happens once, the registrar spend happens every time.
     * `razorpayPaymentId` is the indexed field every other flow keys on;
     * the legacy `paymentId` column is read by nothing.
     */
    const alreadyUsed = await getOrderByRazorpayPaymentId(razorpay_payment_id);
    if (alreadyUsed) {
      serverLogger.warn(
        `[renew] replayed payment refused for ${domainName}: already on order ${alreadyUsed.orderId}`
      );
      return NextResponse.json(
        {
          error:
            "That payment has already been used for an order. Refresh your domain list — if the renewal is not showing, contact support with your payment reference.",
        },
        { status: 409 }
      );
    }

    // Renew domain via the typed wrapper. Outcomes:
    //   renewed         — happy path, carry through orderId + price
    //   balance_pending — RC queued for ops top-up; surface a clear
    //                     user message, but DON'T return a 500 (the
    //                     renewal will complete asynchronously)
    //   hard_failure    — anything else; user sees generic copy, raw
    //                     reason stays in serverLogger
    const outcome = await rcRenewDomain({ domainName, years });

    if (outcome.kind === "balance_pending") {
      return NextResponse.json(
        {
          error:
            "Renewal is queued — our system is finishing the request. Please check your domain list in a few minutes.",
          status: "pending",
        },
        { status: 202 }
      );
    }
    if (outcome.kind === "hard_failure") {
      return NextResponse.json(
        { error: "Failed to renew domain. Our team has been notified." },
        { status: 500 }
      );
    }

    // outcome.kind === "renewed"
    const renewedPrice = outcome.price ?? 0;
    const renewedOrderId = outcome.orderId;

    // Create order record for renewal
    const order = await createOrder({
      orderId: `RENEW_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId: user._id,
      userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      userEmail: user.email,
      // Both required by the Order schema. Omitting them is what made every
      // previous run throw a ValidationError after the registrar was charged.
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature ?? "",
      amount: renewedPrice,
      currency: "INR",
      status: "completed",
      domains: [
        {
          domainName,
          price: renewedPrice,
          currency: "INR",
          registrationPeriod: years,
          status: "registered",
          orderId: renewedOrderId,
          expiresAt: new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000),
        },
      ],
      successfulDomains: [domainName],
    });

    /**
     * NOTE: this currently writes NOTHING. `appendUserDomain` does
     * `$push: { domains: … }` on User, and models/User.ts declares no
     * `domains` path — Mongoose strict mode (on by default; the options
     * block sets no `strict:false`) silently drops it. models/User.ts:93
     * and :416 already document this exact hazard for other fields.
     *
     * Left in place rather than deleted: the renewal's real bookkeeping gap
     * is that nothing updates `expiresAt` on the user's EXISTING order, so
     * removing this would tidy the symptom and leave the gap. Both are
     * recorded in Todos.md §A — they need a decision about where a user's
     * domain list is canonically read from, which is not this fix's job.
     */
    await appendUserDomain(String(user._id), {
      domainName,
      price: renewedPrice,
      currency: "INR",
      registrationPeriod: years,
      status: "registered",
      orderId: renewedOrderId,
      expiresAt: new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000),
    });

    return NextResponse.json({
      success: true,
      message: "Domain renewed successfully",
      orderId: order.orderId,
      domainName,
      years,
      newExpiryDate: new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000),
    });
  } catch (error) {
    serverLogger.error("Domain renewal error:", error);
    return NextResponse.json(
      { error: "Failed to renew domain" },
      { status: 500 }
    );
  }
}
