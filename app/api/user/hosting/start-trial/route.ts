import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";
import { secureJsonResponse } from "@/lib/api-response-wrapper";
import { getSettingValue } from "@/lib/services/settings";
import type { CartItem } from "@/lib/types";
import { evaluateTrialAbuse, getClientIp, hashIp, recordTrialClaim } from "@/lib/trial-abuse";
import { validatedBody, z } from "@/lib/api-validation";
import { isProvisionableDomain, hostingItemDomain } from "@/lib/validation/hosting-domain";
import { isTrialPlan, TRIAL_PLAN_REFUSAL } from "@/lib/pricing/trial-plan";
import {
  startTrialInResellerOs,
  startTrialRefusalMessage,
  TRIAL_STARTED_MESSAGE,
} from "@/lib/reselleros/start-trial";

/**
 * POST /api/user/hosting/start-trial — the panel's free hosting trial,
 * STARTED IN RESELLEROS.
 *
 * Owner, 26 Sep 2026: "Move it to ResellerOS". Until then this route created
 * the trial in DMS itself (a ₹0 Order + a "manual" no-card trial Hosting, then
 * inline DirectAdmin provisioning). Now it creates nothing in DMS: it sends the
 * request to ResellerOS `POST /api/dms/start-trial` (lib/reselleros/start-trial.ts),
 * which runs the site's own trial code — Starter only, one trial per customer
 * across BOTH apps (checked against DMS's shared trial record, which stays),
 * a confirm-your-email link — and the account is created by the DMS engine's
 * `hosting.provision` trial mode once the customer confirms.
 *
 * What stays checked here, because ResellerOS cannot see it: the lone-trial
 * cart shape, Starter and its cycle, DMS's trials switch, and the trial-abuse
 * checks (IP / device / reCAPTCHA), whose claim is recorded only after
 * ResellerOS accepts. Identity (account id, name, email, phone) comes only
 * from the session. Never retried: a timeout may have started the trial.
 * ResellerOS refusing our key is a 503, never a 401 (api-client reads 401 as
 * "signed out").
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
      .object({ id: z.string().optional(), planId: z.string().optional(), name: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const startTrialSchema = z.object({
  cartItems: z.array(cartItemSchema).min(1, "Cart is empty"),
  deviceFingerprint: z.string().optional(),
  recaptchaToken: z.string().nullable().optional(),
});

const refuse = (error: string, status = 400, code?: string) => secureJsonResponse({ error, ...(code ? { code } : {}) }, status);

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return refuse("You're signed out, so the trial wasn't started. Sign in and try again.", 401, "UNAUTHORIZED");

    const validation = await validatedBody(request, startTrialSchema);
    if (!validation.ok) return validation.response;
    const { cartItems: rawItems, deviceFingerprint, recaptchaToken } = validation.data;
    const cartItems = rawItems as CartItem[];

    const item = cartItems[0];
    if (cartItems.length !== 1 || item.itemType !== "hosting" || item.isTrial !== true) {
      return refuse(
        "We couldn't start the free trial with other items in the same cart. Nothing was charged. " +
          "Remove the other items, start the trial on its own, then buy them separately.",
        400,
        "TRIAL_NEEDS_OWN_CHECKOUT"
      );
    }
    if (!isTrialPlan(item.hostingPlan?.id)) return refuse(TRIAL_PLAN_REFUSAL);
    if (item.billingCycle !== "yearly" && item.billingCycle !== "monthly") {
      return refuse("This trial is missing its billing cycle. Remove it from your cart and start the trial again from Buy hosting.");
    }

    const fullName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.replace(/\s+/g, " ").trim();
    if (fullName.length < 2) {
      return refuse("Your account has no name on it, and the trial needs one. Nothing was started. Add your name in Settings (Dashboard → Settings), then try again.");
    }
    const phone = (user.phone ?? "").replace(/[\s-]/g, "");
    if (phone.length < 10 || phone.length > 20) {
      return refuse("Your account has no mobile number, and the trial needs one. Nothing was started. Add it in Settings (Dashboard → Settings), then try again.");
    }

    if ((await getSettingValue<boolean>("hosting_trial_enabled")) === false) {
      return refuse("Free trials are currently unavailable. Nothing was started.");
    }
    const clientIp = getClientIp(request);
    const abuseCheck = await evaluateTrialAbuse(
      { email: user.email, ipHash: hashIp(clientIp), deviceFingerprint },
      { clientIp, recaptchaToken: recaptchaToken || undefined }
    );
    if (!abuseCheck.allowed) {
      serverLogger.warn(`[START-TRIAL] Trial blocked for user=${user.email} reason=${abuseCheck.code}`);
      return refuse(abuseCheck.reason ?? "We couldn't start a free trial from this device or network right now. Nothing was started. Please contact support.", 400, abuseCheck.code);
    }

    // A domain is optional at ResellerOS ("leave blank if you don't have one
    // yet"); send it only when it is a real, provisionable name.
    const domain = hostingItemDomain(item);
    const outcome = await startTrialInResellerOs({
      dmsUserId: String(user._id),
      fullName,
      ...(user.companyName ? { companyName: user.companyName } : {}),
      email: user.email,
      phone,
      ...(isProvisionableDomain(domain) ? { domain } : {}),
      cycle: item.billingCycle,
    });

    if (outcome.kind === "ok") {
      await recordTrialClaim({
        userId: String(user._id),
        userEmail: user.email,
        ipHash: hashIp(clientIp),
        deviceFingerprint,
        planId: item.hostingPlan?.id,
      }).catch((err: unknown) => serverLogger.warn("[START-TRIAL] could not record the trial-abuse claim:", err));
      serverLogger.info(`[START-TRIAL] ResellerOS started the trial for ${user.email} (lead ${outcome.leadId ?? "?"})`);
      return secureJsonResponse({
        success: true,
        leadId: outcome.leadId,
        trialEnds: outcome.trialEnds,
        message: TRIAL_STARTED_MESSAGE,
      });
    }

    const message = startTrialRefusalMessage(outcome);
    switch (outcome.kind) {
      case "already_trialled":
        return refuse(message, 409, "ALREADY_TRIALLED");
      case "refused":
        serverLogger.warn(`[START-TRIAL] ResellerOS refused: ${outcome.message}`);
        return refuse(message, 400, "TRIAL_REFUSED");
      case "failed":
        serverLogger.error(`[START-TRIAL] ResellerOS failed: ${outcome.message}`);
        return refuse(message, 503, "TRIAL_FAILED");
      case "not_configured":
        serverLogger.error(`[START-TRIAL] not configured — set ${outcome.missing.join(" and ")} on DMS.`);
        return refuse(message, 503, "TRIAL_NOT_CONFIGURED");
      case "config":
        serverLogger.error(`[START-TRIAL] ResellerOS refused DMS's panel key or is not configured (HTTP ${outcome.status}: ${outcome.detail}).`);
        return refuse(message, 503, "TRIAL_UNAVAILABLE");
      case "unreachable":
        serverLogger.error(`[START-TRIAL] no usable answer (${outcome.detail}); mayHaveStarted=${outcome.mayHaveStarted}. Not retried.`);
        return secureJsonResponse({ error: message, code: "RESELLEROS_UNREACHABLE", mayHaveStarted: outcome.mayHaveStarted }, 503);
    }
  } catch (error) {
    serverLogger.error("[START-TRIAL] error:", error);
    return refuse("We couldn't start your trial. Nothing was charged. Please try again, or contact support.", 500);
  }
}
