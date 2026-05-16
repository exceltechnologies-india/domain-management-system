import { NextResponse } from "next/server";
import { SettingsService } from "@/lib/settings-service";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const value = await SettingsService.getSetting<unknown>("captcha_enabled", true);
    const enabled = value === true || value === "true";
    return NextResponse.json({ enabled });
  } catch {
    // Default to enabled so captcha is never silently skipped on error
    return NextResponse.json({ enabled: true });
  }
}
