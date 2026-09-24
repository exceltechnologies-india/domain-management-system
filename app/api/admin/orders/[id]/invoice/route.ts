import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getOrderByIdOrOrderId } from "@/lib/services/orders";
import { generateInvoicePdf } from "@/lib/billing/pdf";
import { getUserById } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Accepts EITHER a Mongo `_id` or the user-facing `orderId` string.
    // This used `getOrderById` (findById only), which threw a CastError ->
    // 500 for any non-ObjectId id. That became reachable when the admin
    // invoices page began linking View/Download by `orderId` (9558706), and
    // every one of them 500'd. Mirrors `findUserOrder` on the customer route and
    // `getOrderByIdOrOrderId` on the re-sync route.
    const order = await getOrderByIdOrOrderId(id);

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Fetch the customer for this order
    const customer = await getUserById(String(order.userId));
    if (!customer) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    // Every invoice is rendered here from the order: a Tax Invoice when it
    // carries our engine's GST breakdown, a Proforma copy otherwise
    // (including historical Zoho-issued orders).
    return generateInvoicePdf(order, customer, { adminContext: true });
  } catch (error) {
    serverLogger.error("Failed to fetch invoice PDF:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
