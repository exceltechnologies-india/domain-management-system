import { NextRequest } from "next/server";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { AuthService } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authUser = await AuthService.getUserFromRequest(request);
  if (!authUser) {
    return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
  }
  if ((authUser as any).role !== "admin") {
    return secureErrorResponse("Forbidden", 403, "FORBIDDEN");
  }

  try {
    const result = await ResellerClubAPI.getResellerDetails();

    if (result.status !== "success" || !result.data) {
      serverLogger.warn("[Admin] ResellerClub account fetch failed:", result.error);
      return secureErrorResponse("Failed to fetch ResellerClub account details", 502, "RC_FETCH_FAILED");
    }

    const d = result.data;
    const billingMode: string = d.billingmode || "Unknown";
    const accountStatus: string = d.resellerstatus || "Unknown";

    // Prepaid accounts expose balance fields; NoBilling/credit accounts do not.
    const hasPrepaidWallet = billingMode !== "NoBilling";
    const available = hasPrepaidWallet ? parseFloat(d.availablebalance || "0") : null;
    const unutilised = hasPrepaidWallet ? parseFloat(d.unutilisedsellingbalance || "0") : null;
    const locked = hasPrepaidWallet ? parseFloat(d.lockedbalance || "0") : null;

    return secureJsonResponse({
      success: true,
      account: {
        name: d.name || "",
        resellerId: d.resellerid || "",
        accountStatus,           // "Active" | "Suspended" | etc.
        billingMode,             // "NoBilling" (credit) | "Prepaid" | etc.
        hasPrepaidWallet,
        available,               // null for credit accounts
        unutilised,
        locked,
        totalReceipts: parseFloat(d.totalreceipts || "0"),
      },
    });
  } catch (error: any) {
    serverLogger.error("[Admin] ResellerClub account error:", error.message);
    return secureErrorResponse("Internal error", 500, "INTERNAL_ERROR");
  }
}
