import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { validatedBody, z } from "@/lib/api-validation";
import { serverLogger } from "@/lib/server-logger";
import { isResellerFeatureEnabled } from "@/lib/reseller-flag";
import {
  approveReseller,
  suspendReseller,
  getResellerById,
  ResellerError,
} from "@/lib/services/resellers";

const patchSchema = z.object({
  action: z.enum(["approve", "suspend"]),
});

// PATCH /api/admin/resellers/[id] — approve or suspend a reseller (admin only).
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isResellerFeatureEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const admin = await AuthService.getAdminFromRequest(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const validation = await validatedBody(request, patchSchema);
  if (!validation.ok) return validation.response;

  try {
    const reseller =
      validation.data.action === "approve"
        ? await approveReseller(id, admin._id.toString())
        : await suspendReseller(id);
    return NextResponse.json({ success: true, reseller });
  } catch (err) {
    if (err instanceof ResellerError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    serverLogger.error("[admin/resellers/[id]] patch failed:", err);
    return NextResponse.json({ error: "Failed to update reseller" }, { status: 500 });
  }
}

// GET /api/admin/resellers/[id] — fetch one reseller (admin only).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isResellerFeatureEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const admin = await AuthService.getAdminFromRequest(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const reseller = await getResellerById(id);
  if (!reseller) {
    return NextResponse.json({ error: "Reseller not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, reseller });
}
