import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getBillingQuotes } from "@/lib/integrations/billing-customer";
import { resolveUserBillingCustomerId } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

// GET /api/user/quotes — customer-facing "Pending Amount" list, sourced
// from Billing's quotes. payment_url/pdf_url are Billing's own signed
// links — no new payment or PDF code needed here.
export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const billingCustomerId = await resolveUserBillingCustomerId(user);
    if (!billingCustomerId) {
      return NextResponse.json({ quotes: [] });
    }

    const quotes = await getBillingQuotes(billingCustomerId);
    return NextResponse.json({
      quotes: quotes.map((q) => ({
        id: q.id,
        amount: q.amount,
        currency: q.currency,
        status: q.status,
        pdfUrl: q.pdf_url,
        paymentUrl: q.payment_url,
      })),
    });
  } catch (error) {
    serverLogger.error("Failed to fetch quotes:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
