import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { connectToDatabase } from "@/lib/mongoose";
import {
  getFooterVariant, setFooterVariant,
  getHomeVariant, setHomeVariant,
} from "@/lib/services/appearance";
import { validatedBody, z } from "@/lib/api-validation";
import { serverLogger } from "@/lib/server-logger";

export async function GET(request: NextRequest) {
  const user = await AuthService.getAdminFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await connectToDatabase();
    const [footerVariant, homeVariant] = await Promise.all([getFooterVariant(), getHomeVariant()]);
    return NextResponse.json({ success: true, footerVariant, homeVariant });
  } catch (error) {
    serverLogger.error("Appearance fetch error:", error);
    return NextResponse.json({ error: "Failed to load appearance settings" }, { status: 500 });
  }
}

const patchSchema = z.object({
  footerVariant: z.enum(["classic", "modern"]).optional(),
  homeVariant: z.enum(["landing", "classic"]).optional(),
});

export async function PATCH(request: NextRequest) {
  const user = await AuthService.getAdminFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const validation = await validatedBody(request, patchSchema);
  if (!validation.ok) return validation.response;

  try {
    await connectToDatabase();
    const by = String(user._id ?? user.id ?? "admin");
    if (validation.data.footerVariant) await setFooterVariant(validation.data.footerVariant, by);
    if (validation.data.homeVariant) await setHomeVariant(validation.data.homeVariant, by);
    const [footerVariant, homeVariant] = await Promise.all([getFooterVariant(), getHomeVariant()]);
    return NextResponse.json({ success: true, footerVariant, homeVariant });
  } catch (error) {
    serverLogger.error("Appearance update error:", error);
    return NextResponse.json({ error: "Failed to update appearance settings" }, { status: 500 });
  }
}
