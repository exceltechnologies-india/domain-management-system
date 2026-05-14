import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import Hosting from "@/models/Hosting";
import Domain from "@/models/Domain";
import { EmailService } from "@/lib/email";
import { WhatsAppService } from "@/lib/whatsapp";
import { DirectAdminService as DA } from "@/lib/directadmin";
import { TimeService } from "@/lib/time-service";
import { AUTOMATION_CONFIG } from "@/config/automation";

export const dynamic = "force-dynamic";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function suspendService(
  service: any,
  serviceType: "hosting" | "domain"
): Promise<void> {
  if (serviceType === "hosting" && service.directAdminUsername) {
    try {
      await DA.suspendUser(service.directAdminUsername);
      serverLogger.info(
        `[Worker] DirectAdmin user suspended: ${service.directAdminUsername}`
      );
    } catch (err: any) {
      serverLogger.error(
        `[Worker] Failed to suspend DA user ${service.directAdminUsername}: ${err.message}`
      );
      throw err;
    }
  } else if (serviceType === "domain") {
    serverLogger.info(
      `[Worker] Domain ${service.domainName} marked expired (registrar manages actual suspension)`
    );
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let service: any = null;
  let serviceType: "hosting" | "domain" = "hosting";

  try {
    const authHeader = request.headers.get("x-cron-secret");
    if (!authHeader || authHeader !== process.env.CRON_SECRET) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const body = await request.json();
    const { serviceId, serviceType: sType, simulatedTime } = body;
    serviceType = sType;

    if (!serviceId || !serviceType) {
      return secureErrorResponse("Invalid payload", 400, "INVALID_PAYLOAD");
    }

    await connectDB();

    const Model = serviceType === "hosting" ? Hosting : Domain;
    service = await (Model as any).findById(serviceId).populate("userId");

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
      serviceType === "hosting" ? service.expiryDate : service.expiresAt;

    if (!expiryDate) {
      return secureJsonResponse({ success: true, message: "No expiry date — skipped" });
    }

    const now = TimeService.now(null, simulatedTime);
    const daysLeft = TimeService.daysUntil(expiryDate, now);
    const userEmail: string = service.userId?.email;
    const userWhatsApp: string | undefined = service.userId?.whatsappNumber;
    const userName: string | undefined = service.userId?.firstName
      ? `${service.userId.firstName} ${service.userId.lastName}`.trim()
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
  } catch (error: any) {
    serverLogger.error("[Worker] Process Service Expiry Error:", error.message);
    return secureErrorResponse("Internal error", 500, "INTERNAL_ERROR");
  } finally {
    if (service) {
      try {
        service.processing_until = null;
        await service.save();
      } catch (saveErr: any) {
        serverLogger.error(`[Worker] Failed to unlock service ${service._id}: ${saveErr.message}`);
      }
    }
  }
}
