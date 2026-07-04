import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { getHostingById } from "@/lib/services/hostings";
import Domain from "@/models/Domain";
import { EmailService } from "@/lib/email";
import { WhatsAppService } from "@/lib/whatsapp";
import { suspendUser as daSuspendUser } from "@/lib/integrations/directadmin";
import { TimeService } from "@/lib/time-service";
import { AUTOMATION_CONFIG } from "@/config/automation";
import { validatedBody, z } from "@/lib/api-validation";

const processServiceExpirySchema = z.object({
  serviceId: z.string().min(1),
  serviceType: z.enum(["hosting", "domain"]),
  // Optional escape hatch used by the test-automation route to fast-forward.
  // ISO string only — TimeService.parse accepts string or Date, not raw ms.
  simulatedTime: z.string().optional(),
});

export const dynamic = "force-dynamic";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Loose service-shape carries fields from either Hosting or Domain plus the
// (optionally populated) user. The handler mutates fields like
// `processing_until` / `last_reminder_sent` that aren't on the strict
// IHosting/IDomain types — narrow once at the read sites rather than
// re-wrap every Mongoose mutation.
interface ServiceLike {
  _id: unknown;
  status: string;
  domainName: string;
  directAdminUsername?: string;
  expiryDate?: Date;
  next_action_at?: Date | null;
  processing_until?: Date | null;
  last_reminder_sent?: Date | null;
  price?: number;
  currency?: string;
  userId?:
    | string
    | {
        _id?: unknown;
        email?: string;
        firstName?: string;
        lastName?: string;
        whatsappNumber?: string;
        whatsappOptOut?: boolean;
      };
  save: () => Promise<unknown>;
  [k: string]: unknown;
}

async function suspendService(
  service: ServiceLike,
  serviceType: "hosting" | "domain"
): Promise<void> {
  if (serviceType === "hosting" && service.directAdminUsername) {
    // Branch on the typed outcome instead of catch-everything-and-throw.
    // user_not_found is terminal (no point retrying — the DA account
    // doesn't exist); da_unreachable / hard_failure throw so Cloud
    // Tasks retries the worker.
    const outcome = await daSuspendUser({ username: service.directAdminUsername });
    switch (outcome.kind) {
      case "suspended":
        serverLogger.info(
          `[Worker] DirectAdmin user suspended: ${service.directAdminUsername}`
        );
        return;
      case "user_not_found":
        serverLogger.warn(
          `[Worker] DA user ${service.directAdminUsername} not found — treating as already-suspended (no retry): ${outcome.reason}`
        );
        return;
      case "da_unreachable":
        throw new Error(
          `DA unreachable while suspending ${service.directAdminUsername}: ${outcome.reason}`
        );
      case "hard_failure":
        throw new Error(
          `DA suspendUser hard failure for ${service.directAdminUsername}: ${outcome.reason}`
        );
    }
  } else if (serviceType === "domain") {
    serverLogger.info(
      `[Worker] Domain ${service.domainName} marked expired (registrar manages actual suspension)`
    );
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let service: ServiceLike | null = null;
  let serviceType: "hosting" | "domain" = "hosting";

  try {
    if (!authorizeCronRequest(request)) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const validation = await validatedBody(request, processServiceExpirySchema);
    if (!validation.ok) return validation.response;
    const { serviceId, serviceType: sType, simulatedTime } = validation.data;
    serviceType = sType;

    if (serviceType === "hosting") {
      service = (await getHostingById(serviceId, { populateUser: true })) as unknown as ServiceLike | null;
    } else {
      service = (await Domain.findById(serviceId).populate("userId")) as unknown as ServiceLike | null;
    }

    if (!service) {
      serverLogger.warn(`[Worker] Service ${serviceType}:${serviceId} not found`);
      return secureJsonResponse({ success: true, message: "Not found — skipped" });
    }

    if (["failed", "terminated"].includes(service.status)) {
      return secureJsonResponse({
        success: true,
        message: `Skipped — terminal status: ${service.status}`,
      });
    }

    const expiryDate: Date | undefined =
      serviceType === "hosting" ? service.expiryDate : (service.expiresAt as Date | undefined);

    if (!expiryDate) {
      return secureJsonResponse({ success: true, message: "No expiry date — skipped" });
    }

    const now = TimeService.now(null, simulatedTime);
    const daysLeft = TimeService.daysUntil(expiryDate, now);
    // userId is populated (.populate("userId")) so it's the object form, not the ObjectId
    const populatedUser =
      typeof service.userId === "object" && service.userId !== null
        ? service.userId
        : undefined;
    const userEmail: string = populatedUser?.email || "";
    // Suppress WhatsApp entirely when the customer has opted out (replied
    // STOP). Nulling userWhatsApp here means both the reminder + suspension
    // send sites (which gate on it) respect the opt-out in one place.
    const userWhatsApp: string | undefined =
      populatedUser?.whatsappOptOut === true ? undefined : populatedUser?.whatsappNumber;
    const userName: string | undefined = populatedUser?.firstName
      ? `${populatedUser.firstName} ${populatedUser.lastName ?? ""}`.trim()
      : undefined;

    // ═══════════════════════════════════════════════════════════════════════
    // ── EXPIRY FLOW (STRICT - NO GRACE PERIOD)
    // ═══════════════════════════════════════════════════════════════════════

    // Guard: service is overdue but already handled (e.g. expired via webhook).
    // Without this, the fallback recalculation would reschedule next_action_at
    // to tomorrow, creating an infinite daily loop.
    if (daysLeft <= 0 && service.status !== "active") {
      service.next_action_at = null;
      return secureJsonResponse({
        success: true,
        message: `Skipped — already in non-active state (${service.status}) with no days remaining`,
      });
    }

    if (daysLeft <= 0 && service.status === "active") {
      // Grace period for active Razorpay subscriptions: give the payment webhook
      // up to 1 day to extend the expiry date before suspending.
      const isSubscriptionAutoRenew =
        serviceType === "hosting" &&
        service.autoRenew === true &&
        service.billingType === "subscription" &&
        service.subscriptionId;

      if (isSubscriptionAutoRenew) {
        const gracePeriodMs = 24 * 60 * 60 * 1000;
        const expiredSince = Math.abs(daysLeft);
        if (expiredSince < 1) {
          // Within the 1-day grace window — reschedule and wait
          service.next_action_at = new Date(now.getTime() + gracePeriodMs);
          serverLogger.info(
            `[Worker] Grace period: autoRenew subscription for ${service.domainName} — checking again tomorrow`
          );
          return secureJsonResponse({
            success: true,
            action: "grace_period",
            domain: service.domainName,
            next_action_at: service.next_action_at,
          });
        }
        // Grace period elapsed — subscription payment failed; proceed with suspension
        serverLogger.warn(
          `[Worker] Grace period elapsed for autoRenew subscription ${service.domainName} — suspending`
        );
      }

      await suspendService(service, serviceType);

      service.status = "expired";
      service.next_action_at = null; // No further cron actions until manually recovered

      if (userEmail) {
        await EmailService.sendServiceSuspensionEmail(userEmail, {
          serviceName: service.domainName,
          serviceType,
        }).catch((err) =>
          serverLogger.error(`[Worker] Suspension email failed: ${err.message}`)
        );
      }
      if (userWhatsApp) {
        WhatsAppService.sendServiceSuspended(userWhatsApp, {
          serviceName: service.domainName,
          serviceType,
        }).catch(() => {});
      }

      serverLogger.info(`[Worker] Suspended strictly: ${service.domainName}`);
      return secureJsonResponse({
        success: true,
        action: "expired",
        domain: service.domainName,
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ── REMINDER FLOW (service is still active, approaching expiry)
    // ═══════════════════════════════════════════════════════════════════════
    const reminderDays = [...AUTOMATION_CONFIG.REMINDER_DAYS].sort((a, b) => b - a);

    for (let i = 0; i < reminderDays.length; i++) {
      const daysThreshold = reminderDays[i];
      const nextThreshold = reminderDays[i + 1] || 0; 

      if (daysLeft <= daysThreshold && daysLeft > nextThreshold && service.last_reminder_sent !== daysThreshold) {
        if (userEmail) {
          await EmailService.sendServiceReminderEmail(userEmail, {
            serviceName: service.domainName,
            serviceType,
            daysRemaining: daysLeft,
            amount: service.price || 0,
            currency: service.currency || "INR",
            userName,
          }).catch((err) =>
            serverLogger.error(`[Worker] ${daysThreshold}-day reminder email failed: ${err.message}`)
          );
        }
        if (userWhatsApp) {
          WhatsAppService.sendServiceReminder(userWhatsApp, {
            serviceName: service.domainName,
            daysRemaining: daysLeft,
          }).catch(() => {});
        }

        // We DO NOT change status to "expiring_soon", it stays "active"
        service.last_reminder_sent = daysThreshold;
        
        if (nextThreshold > 0) {
          service.next_action_at = new Date(expiryDate.getTime() - nextThreshold * 24 * 60 * 60 * 1000);
        } else {
          service.next_action_at = new Date(expiryDate);
          service.next_action_at.setUTCHours(0, 0, 0, 0);
        }

        serverLogger.info(`[Worker] ${daysThreshold}-day reminder sent: ${service.domainName}`);
        return secureJsonResponse({
          success: true,
          action: `reminder_${daysThreshold}`,
          domain: service.domainName,
          next_action_at: service.next_action_at,
        });
      }
    }

    // Fallback recalculation
    let foundCheckpoint = false;
    for (const days of reminderDays) {
      if (daysLeft > days) {
        service.next_action_at = new Date(expiryDate.getTime() - days * 24 * 60 * 60 * 1000);
        foundCheckpoint = true;
        break;
      }
    }

    if (!foundCheckpoint) {
      if (daysLeft > 0) {
        service.next_action_at = new Date(expiryDate);
        service.next_action_at.setUTCHours(0, 0, 0, 0);
      } else {
        service.next_action_at = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      }
    }

    return secureJsonResponse({
      success: true,
      message: "No action needed — next checkpoint scheduled",
      next_action_at: service.next_action_at,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[Worker] Process Service Expiry Error:", message);
    return secureErrorResponse("Internal error", 500, "INTERNAL_ERROR");
  } finally {
    if (service) {
      try {
        service.processing_until = null;
        await service.save();
      } catch (saveErr: unknown) {
        const saveMessage = saveErr instanceof Error ? saveErr.message : String(saveErr);
        serverLogger.error(`[Worker] Failed to unlock service ${service._id}: ${saveMessage}`);
      }
    }
  }
}
