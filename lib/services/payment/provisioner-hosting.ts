/**
 * Per-item hosting provisioner. Extracted from the H2 decomposition of
 * `provisionCartItems`. Owns the DA-user creation, Hosting-record insert,
 * provision-email send, and the PendingHosting fallback when DA is
 * unreachable or returns an error.
 *
 * Returns a shape the orchestrator pushes into its accumulator arrays —
 * the helper itself never touches the orchestrator's local state.
 */
import crypto from "crypto";
import { DirectAdminService, DirectAdminError, DA_SERVER_IP } from "@/lib/directadmin";
import { EmailService } from "@/lib/email";
import { serverLogger } from "@/lib/server-logger";
import {
  setUserDirectAdminUsername,
} from "@/lib/services/users";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { createHosting } from "@/lib/services/hostings";
import { createPendingHosting } from "@/lib/services/pending-hostings";
import { calculateHostingDates } from "@/lib/hosting-dates";
import { HOSTING_PLANS } from "@/config/hosting-plans";
import { AUTOMATION_CONFIG } from "@/config/automation";

import type { IUser } from "@/models/User";
import type { CartItem } from "@/lib/types";
import type { OrderDomain, RegistrationResult } from "./provisioner";

const FIRST_REMINDER_DAYS = Math.max(...AUTOMATION_CONFIG.REMINDER_DAYS);

// Price → DirectAdmin package name lookup, derived from the canonical
// HOSTING_PLANS config. Avoids duplicating prices as magic numbers between
// here and config/hosting-plans.ts.
const PRICE_TO_PACKAGE: Record<number, string> = Object.values(HOSTING_PLANS).reduce(
  (acc, plan) => {
    acc[plan.price] = plan.serverPackage;
    return acc;
  },
  {} as Record<number, string>
);

/** Generate a short, unique-enough DA username from the domain prefix. */
function generateDaUsername(domainPrefix: string): string {
  const prefix = domainPrefix.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 5) || "user";
  const suffix = crypto.randomBytes(4).toString("hex").slice(0, 5);
  return `${prefix}${suffix}`;
}

export interface HostingProvisionContext {
  user: IUser;
  orderId: string;
  razorpay_payment_id: string;
  razorpay_subscription_id?: string;
  customerResult: { customerId: number; contactId: number };
}

export interface HostingProvisionResult {
  registrationResult: RegistrationResult;
  orderDomain: OrderDomain;
  /** Set when the item provisioned cleanly — orchestrator pushes onto its
   * successfulDomains array. */
  successfulDomain?: string;
}

/**
 * Provision a single hosting cart item. Pure return-value contract; mutates
 * only `ctx.user.directAdminUsername` (so subsequent items can reuse it),
 * the DA server, and the Hosting / PendingHosting collections.
 */
export async function provisionHostingItem(
  item: CartItem,
  ctx: HostingProvisionContext
): Promise<HostingProvisionResult> {
  const { user, orderId, razorpay_payment_id, razorpay_subscription_id, customerResult } = ctx;
  const targetDomain = item.linkedDomain || item.domainName;
  serverLogger.info(
    `🔄 [PAYMENT-VERIFY] Verified. Provisioning hosting for: ${targetDomain}`
  );

  const packageName = resolveDaPackageName(item);
  const daIp = DA_SERVER_IP;
  const MAX_USERNAME_ATTEMPTS = 3;
  let daUsername = "";

  try {
    for (let attempt = 1; attempt <= MAX_USERNAME_ATTEMPTS; attempt++) {
      daUsername = generateDaUsername(targetDomain);
      serverLogger.info(`👤 [PAYMENT-VERIFY] Generated DA Username (attempt ${attempt}): ${daUsername}`);
      serverLogger.info(`📦 [PAYMENT-VERIFY] Creating DA User: ${daUsername} on package ${packageName} with IP ${daIp}`);
      try {
        await DirectAdminService.createUser(
          daUsername,
          user.email,
          targetDomain,
          packageName,
          daIp
        );
        break; // success — exit retry loop
      } catch (usernameErr: unknown) {
        const errMessage = usernameErr instanceof Error ? usernameErr.message : String(usernameErr);
        const msg = errMessage.toLowerCase();
        if (attempt < MAX_USERNAME_ATTEMPTS && msg.includes("already exists")) {
          serverLogger.warn(`⚠️ [PAYMENT-VERIFY] Username collision on "${daUsername}", retrying (${attempt}/${MAX_USERNAME_ATTEMPTS})`);
          continue;
        }
        throw usernameErr; // non-collision error or final attempt — propagate
      }
    }

    let planName = packageName;
    try {
      const plan = await getPlanByPlanId(packageName);
      if (plan && plan.name) planName = plan.name;
    } catch (e) {
      serverLogger.warn("Failed to fetch hosting plan name for email", e);
    }

    await setUserDirectAdminUsername(String(user._id), daUsername);
    user.directAdminUsername = daUsername;

    serverLogger.info(
      `✅ [PAYMENT-VERIFY] Saved DA username to database: ${daUsername}`
    );

    try {
      await EmailService.sendHostingProvisionedEmail(
        user.email,
        user.firstName || "User",
        {
          domainName: targetDomain,
          packageName: packageName,
          planName: planName,
          serverIp: daIp,
          nameservers: DirectAdminService.NAMESERVERS,
        }
      );
      serverLogger.info(
        `✉️ [PAYMENT-VERIFY] Hosting provision email sent to ${user.email}`
      );
    } catch (emailError: unknown) {
      const message = emailError instanceof Error ? emailError.message : String(emailError);
      serverLogger.error(
        `⚠️ [PAYMENT-VERIFY] Failed to send hosting provision email: ${message}`
      );
    }

    const isTrial = item.isTrial === true;

    // Trial items: always 15-day expiry regardless of registrationPeriod.
    const safeUnit: "months" | "days" | "minutes" = isTrial
      ? "days"
      : item.periodUnit === "years" || !item.periodUnit
      ? "months"
      : item.periodUnit;
    const safePeriod = isTrial ? 15 : (item.registrationPeriod || 1);

    const { registeredAt, expiresAt } = calculateHostingDates(safePeriod, safeUnit);

    try {
      await createHosting({
        userId: user._id,
        domainName: targetDomain,
        planId: packageName,
        name: planName || "Hosting Plan",
        serverPackage: packageName,
        status: "active",
        startDate: registeredAt,
        expiryDate: expiresAt,
        directAdminUsername: daUsername,
        orderId: orderId,
        paymentId: razorpay_payment_id,
        subscriptionId: razorpay_subscription_id || undefined,
        autoRenew: !!razorpay_subscription_id,
        billingType: razorpay_subscription_id ? "subscription" : "manual",
        isTrial,
        next_action_at: new Date(
          expiresAt.getTime() - FIRST_REMINDER_DAYS * 24 * 60 * 60 * 1000
        ),
        last_reminder_sent: null,
      });
      serverLogger.info(
        `✅ [PAYMENT-VERIFY] Hosting record created for ${targetDomain} (Subscription: ${
          razorpay_subscription_id || "None"
        })`
      );
    } catch (hError) {
      serverLogger.error(
        `❌ [PAYMENT-VERIFY] Failed to create Hosting record:`,
        hError
      );
    }

    const validityUnit =
      safeUnit === "days"
        ? "Day"
        : safeUnit === "minutes"
        ? "Minute"
        : "Month";

    const registrationResult: RegistrationResult = {
      domainName: targetDomain,
      status: "success",
      message: isTrial ? "Hosting trial provisioned (15 days free)" : "Hosting account provisioned",
      itemType: "hosting",
      expiresAt: expiresAt.toISOString(),
      validity: `${safePeriod} ${validityUnit}${safePeriod !== 1 ? "s" : ""}`,
    };

    const orderDomain: OrderDomain = {
      domainName: item.domainName,
      price: item.price,
      currency: item.currency || "INR",
      registrationPeriod: safePeriod,
      status: "registered",
      itemType: "hosting",
      dnsProvider: "directadmin",
      periodUnit: safeUnit,
      hostingPlan: {
        ...item.hostingPlan,
        name: planName || item.hostingPlan?.name,
      },
      planName: planName,
      bookingStatus: [
        {
          step: "payment_verified",
          message: "Payment verified successfully",
          timestamp: new Date(),
          progress: 100,
        },
        {
          step: "domain_registered",
          message: "Hosting account active",
          timestamp: new Date(),
          progress: 100,
        },
      ],
      resellerClubCustomerId: customerResult.customerId,
      registeredAt: registeredAt,
      expiresAt: expiresAt,
    };

    return {
      registrationResult,
      orderDomain,
      successfulDomain: targetDomain,
    };
  } catch (error: unknown) {
    return handleHostingProvisionError(error, item, ctx, targetDomain, daUsername, packageName);
  }
}

/**
 * Determine the DA package name to use. Tries (in order):
 *   1. `item.hostingPlan.serverPackage` — explicit
 *   2. Name-based inference (starter/standard/plus)
 *   3. Price-based inference via PRICE_TO_PACKAGE
 *   4. Env-default DA_DEFAULT_PACKAGE → "Starter"
 */
function resolveDaPackageName(item: CartItem): string {
  let packageName = item.hostingPlan?.serverPackage;

  if (!packageName) {
    const planName = (item.hostingPlan?.name || "").toLowerCase();
    if (planName.includes("starter")) packageName = "Starter";
    else if (planName.includes("standard")) packageName = "Standard";
    else if (planName.includes("plus")) packageName = "Plus";

    if (packageName) {
      serverLogger.info(
        `📦 [PAYMENT-VERIFY] Inferred package from name: ${planName} -> ${packageName}`
      );
    }
  }

  if (!packageName) {
    const price = item.price;
    packageName = PRICE_TO_PACKAGE[price];

    if (packageName) {
      serverLogger.info(
        `📦 [PAYMENT-VERIFY] Inferred package from price: ₹${price} -> ${packageName}`
      );
    }
  }

  if (!packageName) {
    packageName = process.env.DA_DEFAULT_PACKAGE || "Starter";
    serverLogger.warn(`⚠️ [PAYMENT-VERIFY] Using fallback package: ${packageName}`);
  }

  return packageName;
}

/**
 * Hosting-provision error path. Distinguishes "DA unreachable / 503" (where
 * the cron retry can recover) from genuine failures, and queues a
 * PendingHosting row either way so admins / the auto-retry have a handle.
 */
async function handleHostingProvisionError(
  error: unknown,
  item: CartItem,
  ctx: HostingProvisionContext,
  targetDomain: string,
  daUsername: string,
  packageName: string
): Promise<HostingProvisionResult> {
  let context = "Hosting Provisioning";
  const errMessage = error instanceof Error ? error.message : String(error);
  let details = errMessage;

  const isDaUnreachable =
    error instanceof DirectAdminError && error.status === 503;

  if (error instanceof DirectAdminError) {
    context = `DA-FAIL: ${error.context || "Unknown Operation"}`;
    details = `${error.message} (Status: ${error.status})`;
    serverLogger.error(`[${context}] ${details}`, {
      response: error.response,
    });
  } else {
    serverLogger.error(
      `[PAYMENT-VERIFY-HOSTING] Unexpected error: ${errMessage}`,
      error
    );
  }

  // User-facing copy is always generic — DA / RC error strings can carry
  // upstream-state fragments (account paths, retry tokens, internal hostnames).
  // Raw `details` stays in serverLogger + PendingHosting for postmortem.
  const userFacingError = isDaUnreachable
    ? "Hosting setup is queued. Our provisioning system is temporarily unavailable — we'll complete this automatically once it's back."
    : "Hosting provisioning failed. Our team has been notified — please contact support if this persists.";

  serverLogger.error(
    isDaUnreachable
      ? `⏳ [PAYMENT-VERIFY] Hosting provisioning deferred (DA unreachable): ${details}`
      : `❌ [PAYMENT-VERIFY] Hosting provisioning failed: ${details}`
  );

  try {
    await createPendingHosting({
      userId: ctx.user._id,
      domain: targetDomain,
      package: packageName,
      daUsername: daUsername,
      error: details,
      status: isDaUnreachable ? "pending" : "failed",
    });
    serverLogger.info(
      `📝 [PAYMENT-VERIFY] Created PendingHosting record (${
        isDaUnreachable ? "pending/deferred" : "failed"
      }) for ${targetDomain}`
    );
  } catch (phError) {
    serverLogger.error(
      `❌ [PAYMENT-VERIFY] Failed to create PendingHosting record:`,
      phError
    );
  }

  const registrationResult: RegistrationResult = {
    domainName: targetDomain,
    status: isDaUnreachable ? "pending" : "failed",
    error: userFacingError,
    itemType: "hosting",
  };

  const orderDomain: OrderDomain = {
    domainName: item.domainName,
    price: item.price,
    currency: item.currency || "INR",
    registrationPeriod: item.registrationPeriod || 1,
    periodUnit: item.periodUnit || "months",
    status: isDaUnreachable ? "pending" : "failed",
    itemType: "hosting",
    dnsProvider: "directadmin",
    hostingPlan: item.hostingPlan,
    bookingStatus: [
      {
        step: isDaUnreachable ? "hosting_deferred" : "domain_failed",
        message: isDaUnreachable
          ? "Provisioning queued — waiting for server availability"
          : userFacingError, // generic — raw `details` stays in serverLogger
        timestamp: new Date(),
        progress: isDaUnreachable ? 50 : 100,
      },
    ],
    error: userFacingError,
  };

  return { registrationResult, orderDomain };
}
