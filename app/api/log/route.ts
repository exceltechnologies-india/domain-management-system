import { NextRequest, NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

// Client logger payload. `details` is the same arbitrary-JSON blob the
// client passes — kept as z.unknown() so server-side loggers receive the
// raw shape (objects, stack-trace strings, etc.).
const clientLogSchema = z.object({
  level: z.enum(["info", "warn", "error"]).optional(),
  message: z.string().max(8000),
  details: z.unknown().optional(),
  url: z.string().max(2000).optional(),
  timestamp: z.string().max(50).optional(),
});

/**
 * POST /api/log
 * Receives logs from the client and forwards them to the server-side logger.
 */
export async function POST(request: NextRequest) {
  try {
    const validation = await validatedBody(request, clientLogSchema);
    if (!validation.ok) return validation.response;
    const { level, message, details, url, timestamp } = validation.data;

    const logMessage = `[Client] [${timestamp}] [${url}] ${message}`;

    switch (level) {
      case 'error':
        serverLogger.error(logMessage, details || "");
        break;
      case 'warn':
        serverLogger.warn(logMessage, details || "");
        break;
      case 'info':
      default:
        serverLogger.info(logMessage, details || "");
        break;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    // Silently fail to avoid client-side logging loops
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
