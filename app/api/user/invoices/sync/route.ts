import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { syncUserInvoicesNow } from "@/lib/invoice-retry";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/user/invoices/sync
 *
 * User-initiated retry for paid orders whose invoice attempt failed. Runs our
 * own GST engine again; its claim refuses any order that already has an
 * invoice, so it cannot duplicate one. Bypasses the background self-heal
 * throttle so the user can force an immediate retry.
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
  } catch (err: unknown) {
    // Log full error server-side; return a generic message to the client.
    serverLogger.error("[InvoiceSync] Unhandled error:", err);
    return NextResponse.json(
      { error: "Invoice sync failed. Please try again or contact support." },
      { status: 500 }
    );
  }
}
