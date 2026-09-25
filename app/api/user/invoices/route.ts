import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { listUserInvoiceOrders } from "@/lib/services/orders";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

const ORDER_STATUS_TO_INVOICE: Record<string, string> = {
  completed: "paid",
  paid:      "paid",
  pending:   "sent",
  processing:"sent",
  failed:    "void",
  refunded:  "void",
};

type OrderRow = Awaited<ReturnType<typeof listUserInvoiceOrders>>[number];

/**
 * The customer's DMS-issued invoices — read-only history. DMS issues no new
 * bills (owner decision, 24 Sep 2026); orders invoiced before that keep their
 * number and their PDF. There is no retry any more: a paid order with no
 * invoice is an operator's to bill in ResellerOS (lib/billing/no-dms-bills.ts).
 */
function mapOrdersToInvoices(orders: OrderRow[]) {
  const invoices = orders.map((order) => {
    const isPaid = ["completed", "paid"].includes(order.status as string);
    const date = (order.createdAt as Date).toISOString();
    // Issued by our engine, or historically by Zoho Books — either way DMS
    // renders the PDF from the order via the orderId-keyed route.
    const issued = Boolean(order.invoiceProvider);
    return {
      invoice_id:     issued ? (order.orderId as string) : "",
      invoice_number: order.invoiceNumber as string,
      date,
      due_date:       date,
      total:          order.amount as number,
      balance:        isPaid ? 0 : (order.amount as number),
      status:         ORDER_STATUS_TO_INVOICE[order.status as string] ?? "draft",
      currency_code:  order.currency as string,
      created_time:   date,
      order_id:       order.orderId as string,
    };
  });
  return { invoices };
}

export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orders = await listUserInvoiceOrders(user._id);
    const { invoices } = mapOrdersToInvoices(orders);

    return NextResponse.json({ invoices });
  } catch (error) {
    serverLogger.error("Failed to fetch invoices:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
