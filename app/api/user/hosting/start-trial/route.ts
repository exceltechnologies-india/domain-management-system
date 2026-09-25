import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";
import { createOrder, userHasPriorTrialOrder } from "@/lib/services/orders";
import { createManualFlowTrialHosting } from "@/lib/services/payment/manual-trial-provisioner";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { getSettingValue } from "@/lib/services/settings";
import type { CartItem } from "@/lib/types";
import { evaluateTrialAbuse, getClientIp, hashIp, recordTrialClaim } from "@/lib/trial-abuse";
import { validatedBody, z } from "@/lib/api-validation";
import {
  isProvisionableDomain,
  hostingItemDomain,
  HOSTING_DOMAIN_REQUIRED_MESSAGE,
} from "@/lib/validation/hosting-domain";
import { isTrialPlan, TRIAL_PLAN_REFUSAL } from "@/lib/pricing/trial-plan";
import { alreadyTrialledMessage, findPriorTrial } from "@/lib/trials/trial-history";

/**
 * POST /api/user/hosting/start-trial — start the ₹0 in-panel hosting trial.
 *
 * Split out of `api/payments/create-order` on 25 Sep 2026, when that route was
 * DELETED: owner decision 30 gives every paid order to ResellerOS, and the
 * cart's paid lines now go to ResellerOS's panel-order. What was left of
 * create-order that DMS legitimately does itself was this: the free trial,
 * which takes no payment (ResellerOS's panel-order refuses trials).
 *
 * The trial gates are create-order's, carried over unchanged: the trial is
 * the only item in the cart; it is Starter (lib/pricing/trial-plan.ts); it
 * carries its cycle; trials are enabled; one trial per user, and per customer
 * across BOTH apps (email, phone, domain — unreadable history refuses);
 * the trial-abuse checks; then the claim is recorded.
 *
 * It is the no-mandate ("manual") trial path only. The Razorpay Tokens CIT
 * mandate and Razorpay Subscriptions branches that create-order also had —
 * both reachable only with DMS_HOSTING_SUBSCRIPTIONS_ENABLED=1, i.e. never by
 * default — are gone: each created a Razorpay order or subscription on DMS's
 * own account ("Remove both", 25 Sep 2026). No Razorpay call exists here.
 */

const cartItemSchema = z
  .object({
    domainName: z.string().min(1),
    price: z.number().nonnegative(),
    currency: z.string().min(1),
    registrationPeriod: z.number().int().positive().optional(),
    itemType: z.enum(["domain", "hosting"]).optional(),
    linkedDomain: z.string().optional(),
    billingCycle: z.enum(["monthly", "yearly"]).optional(),
    periodUnit: z.enum(["months", "years", "minutes", "days"]).optional(),
    isTrial: z.boolean().optional(),
    hostingPlan: z
      .object({
        id: z.string().optional(),
        planId: z.string().optional(),
        name: z.string().optional(),
        serverPackage: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const startTrialSchema = z.object({
  cartItems: z.array(cartItemSchema).min(1, "Cart is empty"),
  deviceFingerprint: z.string().optional(),
  recaptchaToken: z.string().nullable().optional(),
});

/** §7: what happened, why, and what to do next. */
const TRIAL_NEEDS_OWN_CHECKOUT = {
  error:
    "We couldn't start the free trial with other items in the same cart. Nothing was charged. " +
    "Remove the other items, start the trial on its own, then buy them separately.",
  code: "TRIAL_NEEDS_OWN_CHECKOUT",
} as const;

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const validation = await validatedBody(request, startTrialSchema);
    if (!validation.ok) return validation.response;
    const { cartItems: rawItems, deviceFingerprint, recaptchaToken } = validation.data;
    const cartItems = rawItems as CartItem[];

    // Only a lone trial line. A paid line belongs to ResellerOS's checkout.
    const item = cartItems[0];
    if (cartItems.length !== 1 || item.itemType !== "hosting" || item.isTrial !== true) {
      return NextResponse.json(TRIAL_NEEDS_OWN_CHECKOUT, { status: 400 });
    }
    if (!isProvisionableDomain(hostingItemDomain(item))) {
      return NextResponse.json({ error: HOSTING_DOMAIN_REQUIRED_MESSAGE, code: "HOSTING_DOMAIN_REQUIRED" }, { status: 400 });
    }
    if (!isTrialPlan(item.hostingPlan?.id)) {
      return NextResponse.json({ error: TRIAL_PLAN_REFUSAL }, { status: 400 });
    }
    if (item.billingCycle !== "yearly" && item.billingCycle !== "monthly") {
      return NextResponse.json(
        { error: "This trial is missing its billing cycle. Remove it from your cart and start the trial again from Buy hosting." },
        { status: 400 }
      );
    }
    const trialCycle: "monthly" | "yearly" = item.billingCycle;
    const domainName = item.linkedDomain || item.domainName;

    const trialFlag = await getSettingValue<boolean>("hosting_trial_enabled");
    if (trialFlag === false) {
      return NextResponse.json({ error: "Free trials are currently unavailable" }, { status: 400 });
    }
    if (await userHasPriorTrialOrder(user.id)) {
      return NextResponse.json({ error: "You have already used your free trial" }, { status: 400 });
    }
    try {
      const cross = await findPriorTrial({ email: user.email, phone: user.phone, domain: item.linkedDomain });
      if (cross.found) return NextResponse.json({ error: alreadyTrialledMessage(cross) }, { status: 400 });
    } catch (err) {
      serverLogger.error("[START-TRIAL] trial history unreadable", err);
      return NextResponse.json(
        { error: "We couldn't check whether you've had a trial before, so the trial wasn't started. Nothing was charged. Please try again in a minute." },
        { status: 503 }
      );
    }

    const clientIp = getClientIp(request);
    const abuseCheck = await evaluateTrialAbuse(
      { email: user.email, ipHash: hashIp(clientIp), deviceFingerprint },
      { clientIp, recaptchaToken: recaptchaToken || undefined }
    );
    if (!abuseCheck.allowed) {
      serverLogger.warn(`[START-TRIAL] Trial blocked for user=${user.email} reason=${abuseCheck.code}`);
      return NextResponse.json({ error: abuseCheck.reason, code: abuseCheck.code }, { status: 400 });
    }
    await recordTrialClaim({
      userId: String(user.id),
      userEmail: user.email,
      ipHash: hashIp(clientIp),
      deviceFingerprint,
      planId: item.hostingPlan?.id,
    });

    const planKey = item.hostingPlan?.id;
    const plan = planKey ? await getPlanByPlanId(planKey) : null;
    if (!plan) {
      return NextResponse.json(
        { error: "We couldn't find the Starter plan to start your trial on. Nothing was charged. Please contact support." },
        { status: 500 }
      );
    }
    const serverPackage = (plan as { directAdminPackage?: string }).directAdminPackage;

    // The audit-trail Order: ₹0, pending, hosting_trial. No invoice (DMS
    // issues none) and no Razorpay order.
    const internalOrderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    await createOrder({
      orderId: internalOrderId,
      userId: user.id,
      userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
      userEmail: user.email,
      paymentId: `pay_manual_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      razorpayOrderId: `manual_${Date.now()}`,
      razorpayPaymentId: "manual",
      razorpaySignature: "manual",
      amount: 0,
      currency: "INR",
      status: "pending",
      orderType: "hosting_trial",
      mandateMode: "manual",
      domains: [
        {
          domainName,
          price: 0,
          currency: "INR",
          registrationPeriod: 15,
          periodUnit: "days",
          itemType: "hosting",
          isTrial: true,
          hostingPlan: { planId: plan.planId, name: plan.name, serverPackage },
        },
      ],
    } as Record<string, unknown>);

    const provisioned = await createManualFlowTrialHosting({
      userId: user.id,
      domainName,
      planId: plan.planId,
      planName: plan.name,
      serverPackage,
      orderId: internalOrderId,
      billingCycle: trialCycle,
    });
    serverLogger.info(`[START-TRIAL] trial started: order=${internalOrderId} domain=${domainName} plan=${plan.name}`);

    // Inline DirectAdmin provisioning, best-effort: the cron retries on
    // failure, and a provisioning error never fails the signup.
    try {
      const Hosting = (await import("@/models/Hosting")).default;
      const { provisionTokensFlowHosting } = await import("@/lib/services/payment/tokens-da-provisioner");
      const hostingDoc = await Hosting.findById(provisioned.hostingId);
      if (hostingDoc) {
        const r = await provisionTokensFlowHosting(hostingDoc);
        serverLogger.info(`[START-TRIAL] inline DA provisioning outcome=${r.outcome}`);
      }
    } catch (provErr) {
      serverLogger.warn("[START-TRIAL] inline provisioning threw — the cron will retry:", provErr);
    }

    return NextResponse.json({ success: true, manualMode: true, mandateMode: "manual", amount: 0, isTrial: true });
  } catch (error) {
    serverLogger.error("[START-TRIAL] error:", error);
    return NextResponse.json(
      { error: "We couldn't start your trial. Nothing was charged. Please try again, or contact support." },
      { status: 500 }
    );
  }
}
