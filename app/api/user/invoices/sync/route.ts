import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { syncUserInvoicesNow } from "@/lib/zoho-invoice-retry";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/user/invoices/sync
 *
 * User-initiated reconciliation for paid orders whose Zoho Books invoice
 * never finished creating. Searches Zoho by reference_number first
 * (idempotent — won't duplicate). Bypasses the background self-heal throttle
 * so the user can force an immediate retry.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const results = await syncUserInvoicesNow(String(user._id));

    const recovered = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok && !r.skipped).length;
    const skipped = results.filter((r) => !!r.skipped).length;

    return NextResponse.json({
      success: true,
      total: results.length,
      recovered,
      failed,
      skipped,
      results,
    });
  } catch (err: any) {
    serverLogger.error("[InvoiceSync] Unhandled error:", err);
    return NextResponse.json(
      { error: err?.message || "Sync failed" },
      { status: 500 }
    );
  }
}
