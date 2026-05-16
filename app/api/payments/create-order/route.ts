import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import { serverLogger } from "@/lib/server-logger";
import { validateDomainPeriod } from "@/lib/tld-policies";
import { verifyDomainPrices } from "@/lib/services/payment/price-verifier";
import {
  evaluateTrialAbuse,
  getClientIp,
  hashIp,
  recordTrialClaim,
} from "@/lib/trial-abuse";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  serverLogger.info("🚀 [CREATE-ORDER] Request received");
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { cartItems, deviceFingerprint, recaptchaToken, otpToken } = body as {
      cartItems: any[];
      deviceFingerprint?: string;
      recaptchaToken?: string;
      otpToken?: string;
    };

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }

    // Validate cart items
    for (const item of cartItems) {
      if (!item.domainName || item.price === undefined || item.price === null || !item.currency) {
        return NextResponse.json(
          { error: "Invalid cart item data" },
          { status: 400 }
        );
      }
      // Skip TLD policy checks for non-domain items (e.g. hosting)
      if (!item.itemType || item.itemType === "domain") {
        const periodError = validateDomainPeriod(
          item.domainName,
          item.registrationPeriod || 1
        );
        if (periodError) {
          return NextResponse.json({ error: periodError }, { status: 400 });
        }
      }
    }

    // ── Live price verification ──────────────────────────────────────────
    // Fetch fresh RC pricing and recompute the domain total server-side.
    // We never trust client-supplied prices for the actual charge — caching
    // is fine for display, but real money requires live confirmation.
    const priceCheck = await verifyDomainPrices(cartItems);
    if (!priceCheck.ok) {
      serverLogger.warn(
        `🛡️  [CREATE-ORDER] Price mismatch for user ${user.email}: server=₹${priceCheck.serverTotal} client=₹${priceCheck.clientTotal} mismatched=${priceCheck.mismatchedDomains.join(",")}`
      );
      return NextResponse.json(
        {
          error: priceCheck.error,
          code: "PRICE_CHANGED",
          serverTotal: priceCheck.serverTotal,
          clientTotal: priceCheck.clientTotal,
          mismatchedDomains: priceCheck.mismatchedDomains,
        },
        { status: 409 }
      );
    }
    if (priceCheck.fellBackToClient) {
      serverLogger.warn(
        `[CREATE-ORDER] Live RC pricing unavailable — proceeding with client total ₹${priceCheck.clientTotal}`
      );
    }

    const totalAmount = cartItems.reduce(
      (sum: number, item: any) => sum + item.price * (item.registrationPeriod || 1),
      0
    );

    // ── Create Razorpay order/subscription ─────────────────────────────
    try {
      // ── Separate Items by Type ───────────────────────────────────────────
      const domainItems = cartItems.filter((item: any) => !item.itemType || item.itemType === 'domain');
      const hostingItems = cartItems.filter((item: any) => item.itemType === 'hosting');
      const recurringHostingItems = hostingItems;

      let domainAmount = domainItems.reduce((sum: number, item: any) => sum + item.price * (item.registrationPeriod || 1), 0);

      const hasDomains = domainAmount > 0;
      const hasRecurringHosting = recurringHostingItems.length > 0;

      serverLogger.info(`🏷️  [CREATE-ORDER] Domains Total: ₹${domainAmount} | Recurring Hosting Items: ${recurringHostingItems.length}`);

      // 1. Calculate Base One-Time Amount (Domains)
      let oneTimeAmount = domainItems.reduce((sum: number, item: any) => sum + item.price * (item.registrationPeriod || 1), 0);

      let razorpayOrderId = null;
      let subscriptionData = null;

      // 2. Handle Regular Recurring Hosting
      if (hasRecurringHosting) {
        const item = recurringHostingItems[0];
        const isTrial = item.isTrial === true;

        const { connectToDatabase } = await import("@/lib/mongoose");
        const HostingPlan = (await import("@/models/HostingPlan")).default;
        const Order = (await import("@/models/Order")).default;

        await connectToDatabase();

        // Server-side trial eligibility enforcement
        if (isTrial) {
          // Trials are yearly-only
          if (item.billingCycle !== 'yearly' && item.registrationPeriod !== 15) {
            return NextResponse.json({ error: "Trial is only available for yearly hosting plans" }, { status: 400 });
          }
          // One trial per user lifetime
          const Settings = (await import("@/models/Settings")).default;
          const trialSetting = await Settings.findOne({ key: "hosting_trial_enabled" }).lean();
          const trialsEnabled = trialSetting ? (trialSetting as any).value !== false : true;
          if (!trialsEnabled) {
            return NextResponse.json({ error: "Free trials are currently unavailable" }, { status: 400 });
          }
          const priorTrial = await Order.exists({ userId: user.id, orderType: "hosting_trial" });
          if (priorTrial) {
            return NextResponse.json({ error: "You have already used your free trial" }, { status: 400 });
          }

          // Defense-in-depth: re-run the same abuse checks here even though
          // the eligibility endpoint already ran them. The eligibility result
          // is advisory — this is the gate immediately before provisioning.
          const clientIp = getClientIp(request);
          const abuseCheck = await evaluateTrialAbuse(
            {
              email: user.email,
              ipHash: hashIp(clientIp),
              deviceFingerprint,
              phone: user.phone,
              otpToken,
            },
            { recaptchaToken, clientIp }
          );
          if (!abuseCheck.allowed) {
            serverLogger.warn(
              `[CREATE-ORDER] Trial blocked for user=${user.email} reason=${abuseCheck.code}`
            );
            return NextResponse.json(
              { error: abuseCheck.reason, code: abuseCheck.code },
              { status: 400 }
            );
          }

          // Record the claim now — even if Razorpay subscription creation
          // fails downstream, the user has been authorised for the trial
          // and we want subsequent attempts from this IP/device to be
          // throttled either way. The trial-abuse window is 30 days; a
          // false-positive throttle is preferable to letting the same
          // browser retry through a fresh email.
          await recordTrialClaim({
            userId: String(user.id),
            userEmail: user.email,
            ipHash: hashIp(clientIp),
            deviceFingerprint,
            planId: item.hostingPlan?.id || item.planId,
          });
        }

        const plan = await HostingPlan.findOne({ planId: item.hostingPlan?.id || item.planId });

        let subscriptionCreated = false;

        if (plan) {
          // Trials always use the yearly plan ID
          const period = isTrial ? 'yearly' : (item.registrationPeriod === 12 ? 'yearly' : 'monthly');
          const razorpayPlanId = plan.razorpayPlans?.[period];

          if (razorpayPlanId) {
            try {
              const subscription = await RazorpayService.createSubscription(
                razorpayPlanId,
                user.id,
                item.linkedDomain || item.domainName,
                true,
                100,
                isTrial ? 15 : undefined
              );
              subscriptionData = {
                id: subscription.id,
                planName: plan.name,
                period: period
              };
              subscriptionCreated = true;
              serverLogger.info(`✅ [CREATE-ORDER] Subscription Created: ${subscription.id} for ${plan.name}${isTrial ? ' (15-day trial)' : ''}`);
            } catch (subErr) {
              serverLogger.error(`❌ [CREATE-ORDER] Failed to create subscription for ${plan.name}`, subErr);
            }
          } else {
            serverLogger.warn(`⚠️ [CREATE-ORDER] No Razorpay Plan ID found for ${plan.name} (${period})`);
          }
        } else {
          serverLogger.warn(`⚠️ [CREATE-ORDER] HostingPlan not found in DB for planId: ${item.hostingPlan?.planId || item.planId}`);
        }

        // For trials, price=0 so adding it to oneTimeAmount is a no-op either way
        if (!subscriptionCreated) {
          oneTimeAmount += item.price * (item.registrationPeriod || 1);
        }

        for (let i = 1; i < recurringHostingItems.length; i++) {
          const extraItem = recurringHostingItems[i];
          oneTimeAmount += extraItem.price * (extraItem.registrationPeriod || 1);
        }
      }

      // 3. Create One-Time Order if there's any remaining amount
      if (oneTimeAmount > 0) {
        const shortTs = Date.now().toString().slice(-10);
        const rand = Math.random().toString(36).substring(2, 6);
        const receiptId = `ord_${shortTs}_${rand}`;
        
        const rzpOrder = await RazorpayService.createOrder(oneTimeAmount, "INR", receiptId);
        razorpayOrderId = rzpOrder.id;
        serverLogger.info(`✅ [CREATE-ORDER] Order Created: ${razorpayOrderId} for amount: ₹${oneTimeAmount}`);
      }

      // 4. Validate we have a payment target
      if (!razorpayOrderId && !subscriptionData) {
         throw new Error("Failed to generate payment targets. Please try again.");
      }

      const isTrial = recurringHostingItems[0]?.isTrial === true;
      return NextResponse.json({
        success: true,
        razorpayOrderId,
        razorpaySubscriptionId: subscriptionData?.id,
        subscriptionPlan: subscriptionData?.planName,
        amount: oneTimeAmount,
        currency: "INR",
        hasSubscription: !!subscriptionData,
        isTrial: isTrial && !!subscriptionData,
      });
    } catch (razorpayError: any) {
      serverLogger.error(
        "❌ [CREATE-ORDER] Razorpay order creation failed:",
        razorpayError
      );

      // Handle specific Razorpay errors
      if (razorpayError.message?.includes("Invalid amount")) {
        return NextResponse.json(
          { error: "Invalid payment amount. Please refresh and try again." },
          { status: 400 }
        );
      } else if (razorpayError.message?.includes("Amount too small")) {
        return NextResponse.json(
          { error: "Payment amount is too small. Minimum amount is ₹1." },
          { status: 400 }
        );
      } else if (razorpayError.message?.includes("Amount too large")) {
        return NextResponse.json(
          {
            error: "Payment amount is too large. Maximum amount is ₹10,00,000.",
          },
          { status: 400 }
        );
      } else if (razorpayError.message?.includes("Network error")) {
        return NextResponse.json(
          {
            error:
              "Payment gateway is temporarily unavailable. Please try again in a few minutes.",
          },
          { status: 503 }
        );
      } else if (razorpayError.message?.includes("Gateway error")) {
        return NextResponse.json(
          {
            error:
              "Payment gateway error. Please try again or use a different payment method.",
          },
          { status: 502 }
        );
      } else {
        return NextResponse.json(
          { error: "Failed to create payment order. Please try again." },
          { status: 500 }
        );
      }
    }
  } catch (error) {
    serverLogger.error("❌ [CREATE-ORDER] Create order error:", error);
    return NextResponse.json(
      { error: "Failed to create payment order" },
      { status: 500 }
    );
  }
}
