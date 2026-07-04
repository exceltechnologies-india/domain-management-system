import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { WhatsAppService } from "@/lib/whatsapp";
import { getWhatsAppConfig } from "@/lib/services/whatsapp-config";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

export const dynamic = "force-dynamic";

const testSchema = z.object({
  // 10-digit Indian mobile or E.164; WhatsAppService.formatNumber
  // normalises. Keep the schema permissive on shape (digits + a few
  // separators) and let the formatter canonicalise.
  to: z.string().trim().min(7).max(20),
});

/**
 * POST /api/admin/whatsapp/test  { to }
 *
 * Admin-only. Fires a single test WhatsApp template to `to` via
 * `WhatsAppService.sendTest`, which validates token + phone-number ID +
 * template but DELIBERATELY bypasses the master `enabled` flag — so the
 * operator can confirm the integration works BEFORE switching it on for
 * customer traffic.
 *
 * Returns { sent: boolean }. `sent:false` means either the config is
 * incomplete (no token / no phone-number ID) or Meta rejected the send
 * (bad template name, number not opted-in, etc.) — the specific reason is
 * in the server logs (WhatsAppService logs the Meta error body).
 */
export async function POST(request: NextRequest) {
  try {
    const admin = await AuthService.getAdminFromRequest(request);
    if (!admin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, testSchema);
    if (!validation.ok) return validation.response;
    const { to } = validation.data;

    // Pre-check so the UI can give a precise "not configured" message
    // instead of a generic failure when token / phone-number ID is absent.
    const config = await getWhatsAppConfig();
    if (!config.apiToken) {
      return NextResponse.json({
        success: false,
        sent: false,
        reason: "No WhatsApp API token configured. Set WHATSAPP_API_TOKEN in Secret Manager (developer action).",
      });
    }
    if (!config.phoneNumberId) {
      return NextResponse.json({
        success: false,
        sent: false,
        reason: "No phone-number ID configured. Add it in the WhatsApp settings above.",
      });
    }

    serverLogger.info(
      `[Admin WhatsApp test] ${admin.email} sending test message to ${to}`
    );
    const sent = await WhatsAppService.sendTest(to);

    return NextResponse.json({
      success: true,
      sent,
      reason: sent
        ? null
        : "Meta rejected the send. Common causes: template name not approved, or the recipient hasn't opted in / messaged your business number in the last 24h. Check server logs for the exact Meta error.",
    });
  } catch (error) {
    serverLogger.error("[Admin WhatsApp test] error:", error);
    return NextResponse.json(
      { error: "Failed to send test message" },
      { status: 500 }
    );
  }
}
