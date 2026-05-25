import { NextRequest, NextResponse } from "next/server";
import { recordSystemLog } from "@/lib/services/system-logs";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-config";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { validatedBody, z } from "@/lib/api-validation";

const logErrorSchema = z.object({
  message: z.string().min(1).max(10_000),
  source: z.string().max(200).optional(),
  url: z.string().max(2000).optional(),
  stack: z.string().max(20_000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  service: z.string().max(200).optional(),
  requestId: z.string().max(200).optional(),
  statusCode: z.number().int().optional(),
  ip: z.string().max(64).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const validation = await validatedBody(req, logErrorSchema);
    if (!validation.ok) return validation.response;
    const { message, source, url, stack, metadata, service, requestId, statusCode, ip: bodyIp } =
      validation.data;

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
    // Use console.error (NOT serverLogger.error) — the latter POSTs to this
    // same route, so a Mongo / SystemLog-model outage would otherwise turn a
    // single failed log write into an exponential request storm.
    // eslint-disable-next-line no-console
    console.error("[log-error] Failed to record system log:", error);
    return NextResponse.json({ error: "Logging failed" }, { status: 500 });
  }
}
