import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import { serverLogger } from "@/lib/server-logger";
import { validateDomainPeriod } from "@/lib/tld-policies";
import { verifyDomainPrices } from "@/lib/services/payment/price-verifier";
import { createOrder } from "@/lib/services/orders";
import type { CartItem } from "@/lib/types";
import {
  evaluateTrialAbuse,
  getClientIp,
  hashIp,
  recordTrialClaim,
} from "@/lib/trial-abuse";
import { validatedBody, z } from "@/lib/api-validation";

// Per-route schema. Structural shape only — TLD-policy / trial-eligibility
// checks are business logic that runs after the Zod gate.
const cartItemSchema = z.object({
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
      period: z.number().optional(),
      features: z.array(z.string()).optional(),
      serverPackage: z.string().optional(),
    })
    .passthrough()
    .optional(),
  tldAttributes: z.record(z.string(), z.string()).optional(),
}).passthrough();

const createOrderSchema = z.object({
  cartItems: z.array(cartItemSchema).min(1, "Cart is empty"),
  deviceFingerprint: z.string().optional(),
  otpToken: z.string().optional(),
});

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

    const validation = await validatedBody(request, createOrderSchema);
    if (!validation.ok) return validation.response;
    const { cartItems: rawCartItems, deviceFingerprint, otpToken } =
      validation.data;
    const cartItems = rawCartItems as CartItem[];

    // Zod gates structural shape; the TLD policy check is business logic.
    for (const item of cartItems) {
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
      (sum: number, item: CartItem) => sum + item.price * (item.registrationPeriod || 1),
      0
    );

    // ── Create Razorpay order/subscription ─────────────────────────────
    try {
      // ── Separate Items by Type ───────────────────────────────────────────
      const domainItems = cartItems.filter((item: CartItem) => !item.itemType || item.itemType === 'domain');
      const hostingItems = cartItems.filter((item: CartItem) => item.itemType === 'hosting');
      const recurringHostingItems = hostingItems;

      let domainAmount = domainItems.reduce((sum: number, item: CartItem) => sum + item.price * (item.registrationPeriod || 1), 0);

      const hasDomains = domainAmount > 0;
      const hasRecurringHosting = recurringHostingItems.length > 0;

      serverLogger.info(`🏷️  [CREATE-ORDER] Domains Total: ₹${domainAmount} | Recurring Hosting Items: ${recurringHostingItems.length}`);

      // 1. Calculate Base One-Time Amount (Domains)
      let oneTimeAmount = domainItems.reduce((sum: number, item: CartItem) => sum + item.price * (item.registrationPeriod || 1), 0);

      let razorpayOrderId = null;
      let subscriptionData = null;

      // 2. Handle Regular Recurring Hosting
      if (hasRecurringHosting) {
        const item = recurringHostingItems[0];
        const isTrial = item.isTrial === true;

        const HostingPlan = (await import("@/models/HostingPlan")).default;
        const { userHasPriorTrialOrder } = await import("@/lib/services/orders");

        // Server-side trial eligibility enforcement
        if (isTrial) {
          // Trials are yearly-only
          if (item.billingCycle !== 'yearly' && item.registrationPeriod !== 15) {
            return NextResponse.json({ error: "Trial is only available for yearly hosting plans" }, { status: 400 });
          }
          // One trial per user lifetime
          const { getSettingValue } = await import("@/lib/services/settings");
          const trialFlag = await getSettingValue<boolean>("hosting_trial_enabled");
          const trialsEnabled = trialFlag !== false;
          if (!trialsEnabled) {
            return NextResponse.json({ error: "Free trials are currently unavailable" }, { status: 400 });
          }
          const priorTrial = await userHasPriorTrialOrder(user.id);
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
            { clientIp }
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
            planId: item.hostingPlan?.id || (item as CartItem & { planId?: string }).planId,
          });
        }

        const plan = await HostingPlan.findOne({ planId: item.hostingPlan?.id || (item as CartItem & { planId?: string }).planId });

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
          serverLogger.warn(`⚠️ [CREATE-ORDER] HostingPlan not found in DB for planId: ${(item.hostingPlan as { planId?: string } | undefined)?.planId || (item as CartItem & { planId?: string }).planId}`);
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

        // Persist a pending Order row keyed by razorpayOrderId. This closes
        // the race where Razorpay's webhook arrived before /verify committed
        // the order — both paths now find this row and converge via atomic
        // claim. If the DB write fails we refuse the call: leaving a paid
        // Razorpay order with no DB row is worse than a clean failure
        // because the user can retry the checkout.
        try {
          const internalOrderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          const hasDomainItem = cartItems.some((i) => !i.itemType || i.itemType === "domain");
          const hasHostingItem = cartItems.some((i) => i.itemType === "hosting");
          const derivedOrderType: "domain" | "hosting" | "bundle" =
            hasDomainItem && hasHostingItem ? "bundle" : hasHostingItem ? "hosting" : "domain";

          await createOrder({
            orderId: internalOrderId,
            userId: user.id,
            userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
            userEmail: user.email,
            // Placeholders that satisfy the required+unique constraints until
            // /verify or /razorpay/webhook fills in the real values.
            paymentId: `pay_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            razorpayOrderId,
            razorpayPaymentId: "pending",
            razorpaySignature: "pending",
            amount: oneTimeAmount,
            currency: "INR",
            status: "pending",
            orderType: derivedOrderType,
            domains: cartItems.map((item) => ({
              domainName: item.domainName,
              price: item.price,
              currency: item.currency || "INR",
              registrationPeriod: item.registrationPeriod || 1,
              periodUnit:
                item.periodUnit ||
                (item.itemType === "hosting" ? "months" : "years"),
              itemType: item.itemType || "domain",
              // Persist the linked domain for hosting items so /verify can
              // reconstruct the CartItem with the real domain to provision
              // on DirectAdmin (not the synthetic cart-store ID).
              linkedDomain: item.linkedDomain,
              isTrial:
                (item as CartItem & { isTrial?: boolean }).isTrial === true,
              status: "pending",
              hostingPlan: item.hostingPlan
                ? {
                    planId: (item.hostingPlan as CartItem["hostingPlan"] & { planId?: string; id?: string })?.planId ||
                      (item.hostingPlan as CartItem["hostingPlan"] & { id?: string })?.id,
                    name: item.hostingPlan.name,
                    serverPackage: (item.hostingPlan as CartItem["hostingPlan"] & { serverPackage?: string })?.serverPackage,
                  }
                : undefined,
              bookingStatus: [
                {
                  step: "payment_verified",
                  message: "Waiting for payment confirmation",
                  timestamp: new Date(),
                  progress: 5,
                },
              ],
            })),
          });
          serverLogger.info(
            `📝 [CREATE-ORDER] Pending Order persisted: ${internalOrderId} (rzp=${razorpayOrderId})`
          );
        } catch (dbErr) {
          serverLogger.error(
            `❌ [CREATE-ORDER] Failed to persist pending Order for rzp=${razorpayOrderId}:`,
            dbErr
          );
          return NextResponse.json(
            { error: "Failed to initialise order. Please try again." },
            { status: 500 }
          );
        }
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
    } catch (razorpayError: unknown) {
      serverLogger.error(
        "❌ [CREATE-ORDER] Razorpay order creation failed:",
        razorpayError
      );
      const rzpMessage = razorpayError instanceof Error ? razorpayError.message : String(razorpayError);

      // Handle specific Razorpay errors
      if (rzpMessage.includes("Invalid amount")) {
        return NextResponse.json(
          { error: "Invalid payment amount. Please refresh and try again." },
          { status: 400 }
        );
      } else if (rzpMessage.includes("Amount too small")) {
        return NextResponse.json(
          { error: "Payment amount is too small. Minimum amount is ₹1." },
          { status: 400 }
        );
      } else if (rzpMessage.includes("Amount too large")) {
        return NextResponse.json(
          {
            error: "Payment amount is too large. Maximum amount is ₹10,00,000.",
          },
          { status: 400 }
        );
      } else if (rzpMessage.includes("Network error")) {
        return NextResponse.json(
          {
            error:
              "Payment gateway is temporarily unavailable. Please try again in a few minutes.",
          },
          { status: 503 }
        );
      } else if (rzpMessage.includes("Gateway error")) {
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
