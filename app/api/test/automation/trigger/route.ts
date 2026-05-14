import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Hosting from "@/models/Hosting";
import Domain from "@/models/Domain";
import { AUTOMATION_CONFIG } from "@/config/automation";

/**
 * POST /api/test/automation/trigger
 * 
 * Manually trigger the daily scheduler or a specific service worker for testing.
 * Restricted to admins and non-production environments (or ENABLE_TIME_SIMULATION=true).
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Auth check
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin && process.env.NODE_ENV === "production") {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    if (!AUTOMATION_CONFIG.ENABLE_TIME_SIMULATION) {
      return secureErrorResponse("Time simulation is disabled", 403, "DISABLED");
    }

    const body = await request.json();
    const { serviceId, serviceType, now } = body;

    await connectDB();

    // 2. If serviceId is provided, we can either:
    //    a) Force its next_action_at to 'now' and then call daily-scheduler
    //    b) Call the worker directly (simpler for unit testing logic)
    
    // Let's go with (a) because it tests the full scheduler + task queue flow
    if (serviceId && serviceType) {
      let service: any;
      if (serviceType === "hosting") {
        service = await Hosting.findById(serviceId);
      } else {
        service = await Domain.findById(serviceId);
      }
      
      if (!service) return secureErrorResponse("Service not found", 404, "NOT_FOUND");

      // Force eligible for scheduler
      service.next_action_at = new Date(now || new Date());
      service.processing_until = null; // Ensure it's unlocked
      await service.save();
    }

    // 3. Call the daily-scheduler internally or just return instructions
    // For now, we'll just return success and let the user call the daily-scheduler 
    // with the x-simulated-time header, or we can trigger it here.

    // Triggering daily-scheduler via fetch (to keep it decoupled)
    const schedulerUrl = `${process.env.NEXTAUTH_URL}/api/cron/daily-scheduler`;
    const response = await fetch(schedulerUrl, {
      method: "GET",
      headers: {
        "x-cron-secret": process.env.CRON_SECRET || "",
        "x-simulated-time": now || new Date().toISOString(),
      },
    });

    const result = await response.json();

    return secureJsonResponse({
      success: true,
      message: "Automation triggered",
      schedulerResult: result,
      simulatedTime: now || new Date().toISOString(),
    });
  } catch (error: any) {
    return secureErrorResponse(error.message, 500, "INTERNAL_ERROR");
  }
}
