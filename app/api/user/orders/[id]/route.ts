import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { findUserOrder } from "@/lib/services/orders";

export const dynamic = "force-dynamic";

const USER_ORDER_FIELDS =
  "orderId purchaseOrderNumber amount currency status orderType " +
  "domains successfulDomains invoiceNumber zohoInvoiceId " +
  "createdAt updatedAt paymentVerification";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const { id } = await params;
    if (!id) return secureErrorResponse("Order ID required", 400, "MISSING_ID");

    const order = await findUserOrder(id, String(user._id), { select: USER_ORDER_FIELDS });
    if (!order) {
      return secureErrorResponse("Order not found", 404, "NOT_FOUND");
    }

    return secureJsonResponse({ order });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
