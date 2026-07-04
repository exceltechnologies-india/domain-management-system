import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import WhatsAppMessageLog from "@/models/WhatsAppMessageLog";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/whatsapp/message-log?limit=50
 * (named "message-log", not "logs" — a `logs/` .gitignore rule excludes
 *  any directory literally named "logs")
 *
 * Admin-only. Recent WhatsApp outbound sends + their delivery status,
 * newest first. Backs the delivery-audit view (answers "did the day-14
 * reminder reach the customer?"). Capped at 200 rows per call.
 */
export async function GET(request: NextRequest) {
  try {
    const admin = await AuthService.getAdminFromRequest(request);
    if (!admin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const limitParam = Number(new URL(request.url).searchParams.get("limit"));
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50));

    await connectDB();
    const logs = await WhatsAppMessageLog.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<
        Array<{
          messageId: string;
          to: string;
          template?: string;
          status: string;
          error?: string;
          createdAt: Date;
          updatedAt: Date;
        }>
      >();

    return NextResponse.json({
      success: true,
      count: logs.length,
      logs: logs.map((l) => ({
        messageId: l.messageId,
        to: l.to,
        template: l.template ?? null,
        status: l.status,
        error: l.error ?? null,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
    });
  } catch (error) {
    serverLogger.error("[Admin WhatsApp logs] error:", error);
    return NextResponse.json({ error: "Failed to load WhatsApp logs" }, { status: 500 });
  }
}
