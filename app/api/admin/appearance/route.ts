import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { connectToDatabase } from "@/lib/mongoose";
import { getFooterVariant, setFooterVariant } from "@/lib/services/appearance";
import { validatedBody, z } from "@/lib/api-validation";
import { serverLogger } from "@/lib/server-logger";

export async function GET(request: NextRequest) {
  const user = await AuthService.getAdminFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await connectToDatabase();
    return NextResponse.json({ success: true, footerVariant: await getFooterVariant() });
  } catch (error) {
    serverLogger.error("Appearance fetch error:", error);
    return NextResponse.json({ error: "Failed to load appearance settings" }, { status: 500 });
  }
}

const patchSchema = z.object({ footerVariant: z.enum(["classic", "modern"]) });

export async function PATCH(request: NextRequest) {
  const user = await AuthService.getAdminFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const validation = await validatedBody(request, patchSchema);
  if (!validation.ok) return validation.response;

  try {
    await connectToDatabase();
    await setFooterVariant(validation.data.footerVariant, String(user._id ?? user.id ?? "admin"));
    return NextResponse.json({ success: true, footerVariant: await getFooterVariant() });
  } catch (error) {
    serverLogger.error("Appearance update error:", error);
    return NextResponse.json({ error: "Failed to update appearance settings" }, { status: 500 });
  }
}
