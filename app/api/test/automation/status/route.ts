import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Hosting from "@/models/Hosting";
import Domain from "@/models/Domain";
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

    await connectDB();

    let service: any;
    if (serviceType === "hosting") {
      service = await Hosting.findById(serviceId).lean();
    } else {
      service = await Domain.findById(serviceId).lean();
    }

    if (!service) {
      return secureErrorResponse("Service not found", 404, "NOT_FOUND");
    }

    const expiryDate = serviceType === "hosting" ? service.expiryDate : service.expiresAt;
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
  } catch (error: any) {
    return secureErrorResponse(error.message, 500, "INTERNAL_ERROR");
  }
}
