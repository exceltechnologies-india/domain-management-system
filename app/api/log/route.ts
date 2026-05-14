import { NextRequest, NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";

/**
 * POST /api/log
 * Receives logs from the client and forwards them to the server-side logger.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { level, message, details, url, timestamp } = body;

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
