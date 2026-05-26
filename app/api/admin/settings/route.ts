import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { listSettings, upsertSetting, getSetting } from "@/lib/services/settings";
import { connectToDatabase } from "@/lib/mongoose";
import { requireReAuth } from "@/lib/admin-security";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

// value: settings store arbitrary JSON-ish values (strings, numbers, bools,
// nested objects for some keys). z.unknown() preserves that shape — the
// downstream upsertSetting + per-key consumers handle the contract.
const updateSettingSchema = z.object({
  key: z.string().trim().min(1, "Key is required").max(100),
  value: z.unknown().refine((v) => v !== undefined, "Value is required"),
  description: z.string().max(500).optional(),
  category: z.string().max(100).optional(),
});

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

// Step-up re-auth allowlist. The body-supplied `category` field is not
// trustworthy — an admin could update a security key under
// `category: "general"` and skip the password challenge. Source of truth
// is (a) the existing setting's stored category, and (b) this key list
// covering security-critical settings that may not exist yet on the
// server (so the stored-category lookup returns null).
const SECURITY_KEYS = new Set<string>([
  "2fa_required",
  "2fa_enabled",
  "admin_session_timeout",
  "force_logout_all",
  "razorpay_test_key_id",
  "razorpay_test_key_secret",
  "razorpay_live_key_id",
  "razorpay_live_key_secret",
  "directadmin_api_key",
  "directadmin_admin_user",
  "resellerclub_secret",
  "zoho_client_secret",
  "zoho_refresh_token",
  "smtp_pass",
  "anthropic_api_key",
  "cron_secret",
  "auth_secret",
  "nextauth_secret",
  "field_encryption_key",
]);

async function isSecurityScopedKey(key: string): Promise<boolean> {
  if (SECURITY_KEYS.has(key)) return true;
  const existing = await getSetting(key);
  return existing?.category === "security";
}

export async function GET(request: NextRequest) {
  try {
    await connectToDatabase();

    // AuthService.getAdminFromRequest walks Bearer → NextAuth-getToken →
    // NextAuth-session internally; routes used to duplicate that ladder.
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all settings
    const settings = await listSettings();

    // Convert to key-value object for easier frontend usage
    const settingsObject = settings.reduce((acc, setting) => {
      acc[setting.key] = {
        value: setting.value,
        description: setting.description,
        category: setting.category,
        updatedAt: setting.updatedAt,
        updatedBy: setting.updatedBy,
      };
      return acc;
    }, {} as Record<string, unknown>);

    return NextResponse.json({
      success: true,
      settings: settingsObject,
    });
  } catch (error) {
    serverLogger.error("Settings fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectToDatabase();

    // AuthService.getAdminFromRequest walks Bearer → NextAuth-getToken →
    // NextAuth-session internally; routes used to duplicate that ladder.
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, updateSettingSchema);
    if (!validation.ok) return validation.response;
    const { key, value, description, category } = validation.data;

    // Step-up auth: gate on the stored category + key allowlist, NOT the
    // body-supplied `category` field. The body field was previously the
    // sole trigger, so an admin could update `2fa_required` under
    // `category: "general"` and skip the password challenge.
    if (await isSecurityScopedKey(key)) {
      const adminId = String(user._id ?? user.id ?? "");
      const reauth = await requireReAuth(request, adminId);
      if (!reauth.passed) {
        return NextResponse.json(
          { error: "Current password required to update security settings", code: "REAUTH_REQUIRED" },
          { status: 403 }
        );
      }
    }

    await connectToDatabase();

    // Update or create setting
    await upsertSetting(key, value, {
      description: description || "",
      category: category || "general",
      updatedBy: user.email,
    });
    const setting = await getSetting(key);

    return NextResponse.json({
      success: true,
      setting: setting
        ? {
            key: setting.key,
            value: setting.value,
            description: setting.description,
            category: setting.category,
            updatedAt: setting.updatedAt,
            updatedBy: setting.updatedBy,
          }
        : null,
    });
  } catch (error) {
    serverLogger.error("Settings update error:", error);
    return NextResponse.json(
      { error: "Failed to update setting" },
      { status: 500 }
    );
  }
}
