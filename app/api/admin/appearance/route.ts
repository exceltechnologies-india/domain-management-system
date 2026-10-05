import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { connectToDatabase } from "@/lib/mongoose";
import {
  getFooterVariant, setFooterVariant,
  getShowGstin, setShowGstin,
  getSocialLinks, setSocialLinks,
} from "@/lib/services/appearance";
import { validatedBody, z } from "@/lib/api-validation";
import { serverLogger } from "@/lib/server-logger";

export async function GET(request: NextRequest) {
  const user = await AuthService.getAdminFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await connectToDatabase();
    const [footerVariant, showGstin, socialLinks] = await Promise.all([
      getFooterVariant(), getShowGstin(), getSocialLinks(),
    ]);
    return NextResponse.json({ success: true, footerVariant, showGstin, socialLinks });
  } catch (error) {
    serverLogger.error("Appearance fetch error:", error);
    return NextResponse.json({ error: "Failed to load appearance settings" }, { status: 500 });
  }
}

const patchSchema = z.object({
  footerVariant: z.enum(["classic", "modern"]).optional(),
  showGstin: z.boolean().optional(),
  socialLinks: z.object({
    linkedin: z.object({ url: z.string().max(400), enabled: z.boolean() }).partial().optional(),
    facebook: z.object({ url: z.string().max(400), enabled: z.boolean() }).partial().optional(),
    instagram: z.object({ url: z.string().max(400), enabled: z.boolean() }).partial().optional(),
  }).partial().optional(),
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
    if (validation.data.showGstin !== undefined) await setShowGstin(validation.data.showGstin, by);
    if (validation.data.socialLinks) await setSocialLinks(validation.data.socialLinks, by);
    const [footerVariant, showGstin, socialLinks] = await Promise.all([
      getFooterVariant(), getShowGstin(), getSocialLinks(),
    ]);
    return NextResponse.json({ success: true, footerVariant, showGstin, socialLinks });
  } catch (error) {
    serverLogger.error("Appearance update error:", error);
    return NextResponse.json({ error: "Failed to update appearance settings" }, { status: 500 });
  }
}
