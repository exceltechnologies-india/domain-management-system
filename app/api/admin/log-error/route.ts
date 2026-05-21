import { NextRequest, NextResponse } from "next/server";
import { recordSystemLog } from "@/lib/services/system-logs";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-config";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { serverLogger } from "@/lib/server-logger";

export async function POST(req: NextRequest) {
  try {
    const { message, source, url, stack, metadata, service, requestId, statusCode, ip: bodyIp } = await req.json();

    const origin = req.headers.get("origin") || req.headers.get("referer");
    const ip = bodyIp || req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";

    // Accept if: valid internal secret, authenticated session, or same-origin browser request
    const isLocalCron = authorizeCronRequest(req);
    const session = await getServerSession(authOptions);
    const validOrigin = origin
      ? origin.includes(process.env.NEXTAUTH_URL || "")
      : false;

    if (!isLocalCron && !session && !validOrigin) {
      return NextResponse.json({ error: "Unauthorized logger access" }, { status: 401 });
    }

    // Create a new cap-limited log entry
    await recordSystemLog({
      level: "error",
      message,
      source,
      url,
      stack,
      metadata,
      service,
      requestId,
      statusCode,
      ip,
      user: session?.user ? session.user.id : undefined,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    serverLogger.error("Failed to log error to database:", error);
    return NextResponse.json({ error: "Logging failed" }, { status: 500 });
  }
}
