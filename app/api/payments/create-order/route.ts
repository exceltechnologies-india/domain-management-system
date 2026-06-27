import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import { serverLogger } from "@/lib/server-logger";
import { validateDomainPeriod } from "@/lib/tld-policies";
import { verifyDomainPrices } from "@/lib/services/payment/price-verifier";
import { createOrder } from "@/lib/services/orders";
import { createManualFlowTrialHosting } from "@/lib/services/payment/manual-trial-provisioner";
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
  recaptchaToken: z.string().nullable().optional(),
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
    const { cartItems: rawCartItems, deviceFingerprint, otpToken, recaptchaToken } =
      validation.data;
    const cartItems = rawCartItems as CartItem[];

    /**
     * Defensive linkedDomain inference for hosting items.
     *
     * The cart UI's "Please set up a domain for all hosting plans" check is
     * meant to block checkout when a hosting item is missing linkedDomain,
     * but a 60-day production audit on 2026-06-20 found that EVERY hosting
     * order (6/6) was being saved with linkedDomain=undefined — meaning the
     * client-side check never actually populated the field on the request
     * body. Older orders silently "succeeded" in DirectAdmin with the
     * synthetic cart ID as the username (zombie accounts the customer
     * couldn't use); recent orders properly fail.
     *
     * Server-side recovery: if a hosting item has no linkedDomain AND the
     * cart contains exactly one domain item, link them. Unambiguous in
     * practice — every observed failed order matched this shape. The
     * inference happens BEFORE persistence so the DB row + the
     * /verify-side cart reconstruction + provisioner all see the same
     * real domain.
     */
    const domainItems = cartItems.filter((i) => !i.itemType || i.itemType === "domain");
    if (domainItems.length === 1) {
      const inferredDomain = domainItems[0].domainName;
      for (const item of cartItems) {
        if (item.itemType === "hosting" && !item.linkedDomain) {
          item.linkedDomain = inferredDomain;
          serverLogger.info(
            `🔗 [CREATE-ORDER] Auto-linked hosting item to ${inferredDomain} (client sent no linkedDomain)`
          );
        }
      }
    }

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
            { clientIp, recaptchaToken: recaptchaToken || undefined }
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

          // ── Manual-flow branch (no mandate at signup) ───────────────────
          // Temporary trial-without-mandate path while Razorpay UPI Autopay
          // activation is pending (~2026-07-08) and eSign (~2026-06-27).
          // Lets customers sign up + start a trial WITHOUT a Razorpay
          // mandate auth at signup. At trial expiry, the existing renewal-
          // reminder cron (next_action_at) fires + the customer pays
          // manually via /dashboard/hosting/renew → one-shot Razorpay
          // order. No mandate is ever set up; renewals stay manual.
          //
          // When UPI Autopay activates, the operator flips
          // `HOSTING_MANDATE_FLOW=tokens` and new signups go through the
          // mandate-at-signup flow again. Customers who signed up under
          // manual mode keep paying manually — they're not migrated
          // backward into the mandate flow automatically.
          //
          // Gated the same way as the Tokens branch: trial + no mixed
          // cart. Falls through to Subscriptions on any miss.
          const manualFlowAllowed =
            process.env.HOSTING_MANDATE_FLOW === 'manual' &&
            isTrial &&
            oneTimeAmount === 0;

          if (manualFlowAllowed) {
            try {
              const manualInternalOrderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

              // Persist a Mongo Order row so admin UI can find this signup
              // by orderId. status='pending' until the customer eventually
              // pays via the renewal flow — at which point the regular
              // verify-payment + manual-renewal handlers update it.
              // mandateMode='manual' is OUTSIDE the CreateOrderInput
              // literal type ("subscription" | "tokens") so we route
              // through the Record<string, unknown> escape hatch.
              await createOrder({
                orderId: manualInternalOrderId,
                userId: user.id,
                userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
                userEmail: user.email,
                paymentId: `pay_manual_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
                razorpayOrderId: `manual_${Date.now()}`,
                razorpayPaymentId: "manual",
                razorpaySignature: "manual",
                amount: 0, // No charge at signup
                currency: "INR",
                status: "pending",
                orderType: "hosting_trial",
                mandateMode: "manual",
                domains: [
                  {
                    domainName: item.linkedDomain || item.domainName,
                    price: 0,
                    currency: "INR",
                    registrationPeriod: 15,
                    periodUnit: "days",
                    itemType: "hosting",
                    isTrial: true,
                    hostingPlan: {
                      planId: plan.planId,
                      name: plan.name,
                      serverPackage: (plan as { directAdminPackage?: string }).directAdminPackage,
                    },
                  },
                ],
              } as Record<string, unknown>);

              await createManualFlowTrialHosting({
                userId: user.id,
                domainName: item.linkedDomain || item.domainName,
                planId: plan.planId,
                planName: plan.name,
                serverPackage: (plan as { directAdminPackage?: string }).directAdminPackage,
                orderId: manualInternalOrderId,
              });

              subscriptionData = {
                id: manualInternalOrderId,
                planName: plan.name,
                period,
                mode: 'manual' as const,
              };
              subscriptionCreated = true;
              serverLogger.info(
                `✅ [CREATE-ORDER] Manual-mode trial provisioned: order=${manualInternalOrderId} domain=${item.linkedDomain || item.domainName} plan=${plan.name} (no Razorpay involvement)`
              );
            } catch (manErr) {
              serverLogger.error(
                `❌ [CREATE-ORDER] Manual flow failed — falling through to Subscriptions flow:`,
                manErr
              );
              // Intentional fall-through to Subscriptions — manual flow
              // is the new opt-in path; the existing Subscriptions flow
              // is the battle-tested fallback.
            }
          }

          // ── Tokens-flow branch (Phase 2A — scoped MVP) ────────────────────
          // Only fires when ALL of:
          //   - HOSTING_MANDATE_FLOW=tokens (operator opt-in)
          //   - this item is a free trial (the conversion-killing UX surface)
          //   - oneTimeAmount === 0 so far (no mixed cart — domain + trial
          //     mixed-cart deferred to Phase 2B; needs Razorpay checkout to
          //     accept one auth order_id at a time so domain co-purchase
          //     needs separate authorization flow)
          //   - user.phone is set (createCustomer needs a contact number)
          // Falls through to the Subscriptions flow on any miss so production
          // is never blocked by a missing precondition.
          const tokensFlowAllowed =
            !subscriptionCreated && // skip if manual branch already provisioned
            process.env.HOSTING_MANDATE_FLOW === 'tokens' &&
            isTrial &&
            oneTimeAmount === 0 &&
            !!user.phone;

          if (tokensFlowAllowed) {
            try {
              const customer = await RazorpayService.createCustomer({
                name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
                email: user.email,
                contact: user.phone as string,
                notes: { user_id: String(user.id) },
              });

              // NPCI hard caps card-token recurring at Rs 15,000 (1500000 paise).
              // All current tiers (Starter Rs 599.88/yr through Plus Rs 2246.40/yr) are
              // well below that; setting max_amount at the cap gives headroom
              // for tier upgrades + multi-year prepayments via the same token.
              const tokenOrder = await RazorpayService.createRecurringTokenOrder({
                customerId: customer.id,
                validationAmountInPaise: 200,  // Rs 2 — the "and reverse" amount
                maxAmountInPaise: 1500000,      // Rs 15,000 NPCI cap
                method: 'card',                  // Razorpay overlay shows all enabled methods
                frequency: 'as_presented',       // merchant-driven recurring cadence
                receipt: `auth_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                notes: {
                  type: 'mandate_validation',
                  user_id: String(user.id),
                  domain_name: item.linkedDomain || item.domainName,
                  plan_id: plan.planId,
                  plan_name: plan.name,
                  period,
                  is_trial: 'true',
                  // First MIT charge fires after 15-day trial. Cron reads this
                  // and the trial_expiry_unix below to schedule the renewal.
                  trial_days: '15',
                  intended_charge_paise: String(Math.round(plan.renewalPrice * 12 * 100)),
                },
              });

              subscriptionData = {
                id: tokenOrder.id,            // For backward-compat with `razorpaySubscriptionId` consumers — actually the auth order id in tokens mode
                planName: plan.name,
                period,
                mode: 'tokens' as const,
                customerId: customer.id,
                orderId: tokenOrder.id,
              };
              subscriptionCreated = true;
              serverLogger.info(
                `✅ [CREATE-ORDER] Tokens auth order created: ${tokenOrder.id} (customer=${customer.id}, plan=${plan.name}, validation=Rs 2)`
              );

              // Persist a Mongo Order row so the webhook can find this CIT
              // auth event by razorpayOrderId. status='pending' until the
              // webhook fires payment.captured and stores token_id + refunds
              // the Rs 2 (handleMandateValidationCaptured in
              // app/razorpay/webhook/route.ts).
              const tokensInternalOrderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
              try {
                await createOrder({
                  orderId: tokensInternalOrderId,
                  userId: user.id,
                  userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
                  userEmail: user.email,
                  paymentId: `pay_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
                  razorpayOrderId: tokenOrder.id,
                  razorpayPaymentId: "pending",
                  razorpaySignature: "pending",
                  amount: 2, // Rs 2 validation, not the plan price — that fires later as MIT
                  currency: "INR",
                  status: "pending",
                  orderType: "hosting_trial",
                  mandateMode: "tokens",
                  razorpayCustomerId: customer.id,
                  domains: [
                    {
                      domainName: item.linkedDomain || item.domainName,
                      price: 0,
                      currency: "INR",
                      registrationPeriod: 15,
                      periodUnit: "days",
                      itemType: "hosting",
                      isTrial: true,
                      hostingPlan: {
                        planId: plan.planId,
                        name: plan.name,
                        serverPackage: (plan as { directAdminPackage?: string }).directAdminPackage,
                      },
                    },
                  ],
                });
                serverLogger.info(
                  `✅ [CREATE-ORDER] Tokens-mode Mongo Order row persisted: ${tokensInternalOrderId} (rzpOrder=${tokenOrder.id})`
                );
              } catch (orderErr) {
                serverLogger.error(
                  `❌ [CREATE-ORDER] Failed to persist Tokens-mode Order row — webhook will not find it; manual intervention required:`,
                  orderErr
                );
                // Don't fall through to Subscriptions here — the Razorpay CIT
                // auth order is already created. If we fell back now, the
                // customer would have a stray auth order that never gets
                // refunded. Better to fail the call so the customer retries.
                throw orderErr;
              }
            } catch (tokErr) {
              serverLogger.error(
                `❌ [CREATE-ORDER] Tokens flow failed — falling through to Subscriptions flow:`,
                tokErr
              );
              // Intentional fall-through: any failure in the Tokens flow
              // (Razorpay API down, customer-creation race, invalid phone)
              // should not block the customer from completing checkout.
              // The Subscriptions flow below is the existing, battle-tested path.
            }
          }

          // ── Subscriptions-flow branch (existing default path) ─────────────
          if (!subscriptionCreated) {
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
                  period: period,
                  mode: 'subscription' as const,
                };
                subscriptionCreated = true;
                serverLogger.info(`✅ [CREATE-ORDER] Subscription Created: ${subscription.id} for ${plan.name}${isTrial ? ' (15-day trial)' : ''}`);
              } catch (subErr) {
                serverLogger.error(`❌ [CREATE-ORDER] Failed to create subscription for ${plan.name}`, subErr);
              }
            } else {
              serverLogger.warn(`⚠️ [CREATE-ORDER] No Razorpay Plan ID found for ${plan.name} (${period})`);
            }
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

      // Tokens-mode response shape: the CIT auth order_id replaces the
      // subscription_id; frontend opens Razorpay checkout with order_id +
      // customer_id + recurring: 1 instead of subscription_id.
      const isTokensMode = subscriptionData?.mode === 'tokens';
      // Manual-mode response shape: NO Razorpay interaction at all.
      // Frontend sees `manualMode: true` and skips razorpay.open()
      // entirely, redirecting to the dashboard with a success toast.
      const isManualMode = subscriptionData?.mode === 'manual';

      return NextResponse.json({
        success: true,
        razorpayOrderId: isManualMode
          ? undefined
          : isTokensMode
            ? subscriptionData?.orderId
            : razorpayOrderId,
        razorpaySubscriptionId: isManualMode || isTokensMode ? undefined : subscriptionData?.id,
        razorpayCustomerId: isTokensMode ? subscriptionData?.customerId : undefined,
        subscriptionPlan: subscriptionData?.planName,
        mandateMode: subscriptionData?.mode ?? null,  // 'subscription' | 'tokens' | 'manual' | null
        manualMode: isManualMode,
        amount: isManualMode ? 0 : isTokensMode ? 2 : oneTimeAmount,
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
