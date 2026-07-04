import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getWhatsAppConfig, isWhatsAppConfigured } from "@/lib/services/whatsapp-config";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/whatsapp/status
 *
 * Admin-only. Returns the RESOLVED WhatsApp config status for the admin
 * settings UI — WITHOUT ever returning the token value. The token is
 * env/Secret-Manager-only; the UI shows only whether it's present
 * (`hasToken`), never the value. Everything else (enable flag,
 * phone-number ID, business number, templates) is the resolved value the
 * runtime would actually use, so the operator sees the effective config
 * (DB override OR env fallback) not just what they typed into the panel.
 */
export async function GET(request: NextRequest) {
  try {
    const admin = await AuthService.getAdminFromRequest(request);
    if (!admin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const config = await getWhatsAppConfig();

    return NextResponse.json({
      success: true,
      status: {
        enabled: config.enabled,
        // Never leak the token — only its presence. Sourced from
        // env/Secret Manager; a developer manages it.
        hasToken: !!config.apiToken,
        phoneNumberId: config.phoneNumberId ?? "",
        businessNumber: config.businessNumber ?? "",
        templates: config.templates,
        // Send-ready = enabled && token && phoneNumberId. The UI's status
        // pill keys off this.
        ready: isWhatsAppConfigured(config),
      },
    });
  } catch (error) {
    serverLogger.error("[Admin WhatsApp status] error:", error);
    return NextResponse.json(
      { error: "Failed to load WhatsApp status" },
      { status: 500 }
    );
  }
}
