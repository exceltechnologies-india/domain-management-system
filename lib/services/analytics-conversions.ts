/**
 * Outcome-confirmed conversion events for the ad campaign.
 *
 * Each Meta event fires ONLY when the real business outcome is confirmed
 * server-side (provisioning / renewal), never on a click or an unfulfilled
 * payment:
 *   - StartTrial      → a trial hosting is provisioned (DA account assigned,
 *                       status active). Idempotent per hosting.
 *   - Purchase        → a paid hosting/domain is provisioned + assigned.
 *   - TrialConversion → a trial's paid renewal succeeded (hosting renewed).
 *
 * All fire via the Meta Conversions API with hashed PII + persisted
 * attribution + a deterministic event_id (dedup). Never throw into the caller.
 */

import Hosting, { type IHosting } from "@/models/Hosting";
import User from "@/models/User";
import { sendMetaServerEvent } from "@/lib/meta-capi";
import { recordActivity } from "@/lib/services/analytics";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { serverLogger } from "@/lib/server-logger";

interface UserLike {
  email?: string | null;
  phone?: string | null;
  attribution?: { fbclid?: string; landingPage?: string } | null;
}

async function loadUser(userId: unknown): Promise<UserLike | null> {
  try {
    return await User.findById(String(userId))
      .select("email phone attribution")
      .lean<UserLike>();
  } catch {
    return null;
  }
}

/**
 * Fire the outcome event when a hosting account is CONFIRMED provisioned
 * (DA assigned + active). Trial → StartTrial, paid → Purchase.
 * Idempotent: atomically claims `conversionEventSent` so it fires once per
 * hosting even across sync + async + cron provisioning paths.
 */
export async function recordHostingProvisioned(hostingId: string): Promise<void> {
  try {
    // Atomic claim — only the first caller proceeds.
    const hosting = await Hosting.findOneAndUpdate(
      { _id: hostingId, conversionEventSent: { $ne: true }, status: "active" },
      { $set: { conversionEventSent: true } },
      { new: false },
    ).lean<IHosting & { _id: unknown; userId: unknown; planId: string; isTrial: boolean; domainName: string }>();
    if (!hosting) return; // already sent, not found, or not active

    const user = await loadUser(hosting.userId);
    const fbclid = user?.attribution?.fbclid || null;
    const eventSourceUrl = user?.attribution?.landingPage;

    if (hosting.isTrial === true) {
      await recordActivity({ activity: "start_trial", userId: String(hosting.userId), metadata: { hostingId, confirmed: true } });
      await sendMetaServerEvent({
        eventName: "StartTrial",
        eventId: `starttrial_${hostingId}`,
        user: { email: user?.email, phone: user?.phone },
        customData: { content_name: hosting.planId, content_category: "hosting_trial", currency: "INR", value: 0 },
        eventSourceUrl,
        fbclid,
      });
    } else {
      let value = 0;
      try { value = (await getPlanByPlanId(hosting.planId))?.price ?? 0; } catch { /* best effort */ }
      await recordActivity({ activity: "purchase", userId: String(hosting.userId), metadata: { hostingId, planId: hosting.planId } });
      await sendMetaServerEvent({
        eventName: "Purchase",
        eventId: `purchase_hosting_${hostingId}`,
        user: { email: user?.email, phone: user?.phone },
        customData: { content_name: hosting.planId, content_category: "hosting", order_type: "direct", currency: "INR", value },
        eventSourceUrl,
        fbclid,
      });
    }
  } catch (error) {
    serverLogger.error("[analytics-conversions] recordHostingProvisioned failed", error);
  }
}

/** Fire TrialConversion when a trial's paid renewal has gone through. */
export async function recordTrialConversion(opts: {
  userId: unknown;
  orderId: string;
  value: number;
  currency?: string;
  planName?: string;
}): Promise<void> {
  try {
    const user = await loadUser(opts.userId);
    await recordActivity({ activity: "purchase", userId: opts.userId as string, metadata: { orderId: opts.orderId, trialConversion: true } });
    await sendMetaServerEvent({
      eventName: "TrialConversion",
      eventId: `trialconv_${opts.orderId}`,
      user: { email: user?.email, phone: user?.phone },
      customData: {
        order_id: opts.orderId,
        order_type: "trial_conversion",
        content_name: opts.planName,
        content_category: "hosting",
        currency: opts.currency || "INR",
        value: opts.value || 0,
      },
      eventSourceUrl: user?.attribution?.landingPage,
      fbclid: user?.attribution?.fbclid || null,
    });
  } catch (error) {
    serverLogger.error("[analytics-conversions] recordTrialConversion failed", error);
  }
}

/** Fire Purchase when a domain is CONFIRMED registered/assigned. */
export async function recordDomainProvisioned(opts: {
  userId: unknown;
  orderId: string;
  domainName: string;
  value?: number;
  currency?: string;
}): Promise<void> {
  try {
    const user = await loadUser(opts.userId);
    await recordActivity({ activity: "purchase", userId: opts.userId as string, metadata: { orderId: opts.orderId, domain: opts.domainName } });
    await sendMetaServerEvent({
      eventName: "Purchase",
      eventId: `purchase_domain_${opts.orderId}_${opts.domainName}`,
      user: { email: user?.email, phone: user?.phone },
      customData: {
        order_id: opts.orderId,
        order_type: "direct",
        content_name: opts.domainName,
        content_category: "domain",
        currency: opts.currency || "INR",
        value: opts.value ?? 0,
      },
      eventSourceUrl: user?.attribution?.landingPage,
      fbclid: user?.attribution?.fbclid || null,
    });
  } catch (error) {
    serverLogger.error("[analytics-conversions] recordDomainProvisioned failed", error);
  }
}
