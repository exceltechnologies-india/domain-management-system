import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const { id } = await params;
    if (!id) return secureErrorResponse("Order ID required", 400, "MISSING_ID");

    await connectDB();

    const order = await Order.findOne({
      orderId: id,
      userId: user._id,
      isDeleted: { $ne: true },
    })
      .select(
        "orderId purchaseOrderNumber amount currency status orderType " +
        "domains successfulDomains invoiceNumber zohoInvoiceId " +
        "createdAt updatedAt paymentVerification"
      )
      .lean();

    if (!order) {
      return secureErrorResponse("Order not found", 404, "NOT_FOUND");
    }

    return secureJsonResponse({ order });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
