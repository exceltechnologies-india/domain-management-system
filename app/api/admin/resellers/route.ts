import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { validatedBody, z } from "@/lib/api-validation";
import { serverLogger } from "@/lib/server-logger";
import { isResellerFeatureEnabled } from "@/lib/reseller-flag";
import { createReseller, listResellers, ResellerError } from "@/lib/services/resellers";

const createResellerSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required").max(254),
  businessName: z.string().trim().min(2, "Business name is required").max(120),
  markupPercent: z.number().min(0).max(100).optional(),
});

// GET /api/admin/resellers — list all resellers (admin only).
export async function GET(request: NextRequest) {
  if (!isResellerFeatureEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const admin = await AuthService.getAdminFromRequest(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const resellers = await listResellers();
    return NextResponse.json({ success: true, resellers });
  } catch (err) {
    serverLogger.error("[admin/resellers] list failed:", err);
    return NextResponse.json({ error: "Failed to load resellers" }, { status: 500 });
  }
}

// POST /api/admin/resellers — create a reseller (admin only).
export async function POST(request: NextRequest) {
  if (!isResellerFeatureEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const admin = await AuthService.getAdminFromRequest(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const validation = await validatedBody(request, createResellerSchema);
  if (!validation.ok) return validation.response;

  try {
    const reseller = await createReseller(validation.data, admin._id.toString());
    return NextResponse.json({ success: true, reseller }, { status: 201 });
  } catch (err) {
    if (err instanceof ResellerError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    serverLogger.error("[admin/resellers] create failed:", err);
    return NextResponse.json({ error: "Failed to create reseller" }, { status: 500 });
  }
}
