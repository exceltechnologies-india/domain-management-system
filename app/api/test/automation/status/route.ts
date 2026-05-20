import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { getHostingById } from "@/lib/services/hostings";
import { getDomainById } from "@/lib/services/domains";
import { TimeService } from "@/lib/time-service";

/**
 * GET /api/test/automation/status?serviceId=xxx&serviceType=hosting
 * 
 * View the current automation state of a service.
 */
export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin && process.env.NODE_ENV === "production") {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const { searchParams } = new URL(request.url);
    const serviceId = searchParams.get("serviceId");
    const serviceType = searchParams.get("serviceType");
    const simulatedNow = searchParams.get("now");

    if (!serviceId || !serviceType) {
      return secureErrorResponse("Missing parameters", 400, "INVALID_PARAMS");
    }

    // Shared fields the test-automation status read needs across Hosting/Domain.
    // Each model has its own expiry-field name (hosting uses expiryDate, domain
    // uses expiresAt), so we project the structural union here.
    interface ServiceSnapshot {
      _id: unknown;
      domainName?: string;
      status?: string;
      expiryDate?: Date;
      expiresAt?: Date;
      next_action_at?: Date;
      last_reminder_sent?: Date | null;
      processing_until?: Date | null;
    }
    let service: ServiceSnapshot | null;
    if (serviceType === "hosting") {
      service = (await getHostingById(serviceId, { lean: true })) as unknown as ServiceSnapshot | null;
    } else {
      service = (await getDomainById(serviceId)) as unknown as ServiceSnapshot | null;
    }

    if (!service) {
      return secureErrorResponse("Service not found", 404, "NOT_FOUND");
    }

    const expiryDate = serviceType === "hosting" ? service.expiryDate : service.expiresAt;
    if (!expiryDate) {
      return secureErrorResponse("Service has no expiry date", 400, "NO_EXPIRY");
    }
    const now = TimeService.now(null, simulatedNow || undefined);
    const daysLeft = TimeService.daysUntil(expiryDate, now);

    return secureJsonResponse({
      success: true,
      data: {
        id: service._id,
        domainName: service.domainName,
        status: service.status,
        expiryDate,
        now: now.toISOString(),
        daysLeft,
        next_action_at: service.next_action_at,
        last_reminder_sent: service.last_reminder_sent,
        processing_until: service.processing_until,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal error";
    return secureErrorResponse(message, 500, "INTERNAL_ERROR");
  }
}
