import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import { serverLogger } from "@/lib/server-logger";
import { listInvoiceOrdersAdmin } from "@/lib/services/orders";

export const dynamic = 'force-dynamic';

const ORDER_STATUS_TO_INVOICE: Record<string, string> = {
  completed: "paid",
  paid:      "paid",
  pending:   "sent",
  processing:"sent",
  failed:    "void",
  refunded:  "void",
};

/**
 * GET /api/admin/invoices?page=&per_page=
 *
 * Every issued invoice, from our own database — the only place an invoice
 * exists since Zoho Books was removed on 24 Sep 2026. Rows carry `provider`
 * ('primary', or 'zoho' for historical ones) and `order_id`, which is how the
 * client addresses the PDF. `invoice_id` is the order id too, kept for older
 * consumers of this shape. `total` is a real count.
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    serverLogger.info('[AdminAPI] Invoice Request received');
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      serverLogger.info('[AdminAPI] Unauthorized access attempt');
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1");
    const perPage = parseInt(searchParams.get("per_page") || "20");

    const { orders, hasMore, total } = await listInvoiceOrdersAdmin(page, perPage);
    serverLogger.info(
      `[AdminAPI] fetching invoices from the local DB (page ${page}, ${orders.length} rows)`
    );

    const invoices = orders.map((order) => {
      const date = (order.createdAt as Date).toISOString();
      const isPaid = ["completed", "paid"].includes(order.status as string);
      return {
        invoice_id:     order.orderId as string,
        invoice_number: order.invoiceNumber as string,
        customer_name:  (order.userName as string) || (order.userEmail as string) || "",
        email:          order.userEmail as string,
        date,
        due_date:       date,
        created_time:   date,
        total:          order.amount as number,
        balance:        isPaid ? 0 : (order.amount as number),
        status:         ORDER_STATUS_TO_INVOICE[order.status as string] ?? "draft",
        currency_code:  (order.currency as string) || "INR",
        provider:       order.invoiceProvider,
        order_id:       order.orderId as string,
      };
    });

    return NextResponse.json({
      success: true,
      invoices,
      // `total` is a REAL count (our own collection).
      page_context: { page, per_page: perPage, has_more_page: hasMore, total },
    });
  } catch (error) {
    serverLogger.error("Failed to fetch admin invoices:", error);
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 }
    );
  }
}
