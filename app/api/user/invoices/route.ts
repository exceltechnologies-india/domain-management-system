import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { listUserInvoiceOrders } from "@/lib/services/orders";
import { serverLogger } from "@/lib/server-logger";
import { selfHealUserInvoices } from "@/lib/invoice-retry";

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

function mapOrdersToInvoices(orders: OrderRow[]) {
  let hasFailed = false;
  const invoices = orders.map((order) => {
    const isPaid = ["completed", "paid"].includes(order.status as string);
    const date = (order.createdAt as Date).toISOString();
    // Issued by our engine, or historically by Zoho Books — either way DMS
    // renders the PDF from the order via the orderId-keyed route.
    const issued = Boolean(order.invoiceProvider);
    // Paid, not issued, and an attempt is known to have failed. Only this
    // state offers the customer a retry; lib/invoice-retry keys on the same.
    const failed = isPaid && !issued && Boolean(order.invoiceFailedAt);
    if (failed) hasFailed = true;

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
      // Renders a "Generating · Retry" pill instead of the empty-action state.
      invoice_failed: failed,
    };
  });
  return { invoices, hasFailed };
}

export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orders = await listUserInvoiceOrders(user._id);
    let { invoices, hasFailed } = mapOrdersToInvoices(orders);

    // Self-heal: retry the invoice for any paid order whose attempt failed.
    // Runs inline (awaited) because Cloud Run throttles CPU after the response
    // is sent — fire-and-forget promises die mid-call. Gated by a 5-min Redis
    // throttle per order, so reloads within the window are no-ops (~10ms).
    if (hasFailed) {
      const results = await selfHealUserInvoices(String(user._id));
      if (results.some((r) => r.ok)) {
        const refreshed = await listUserInvoiceOrders(user._id);
        ({ invoices } = mapOrdersToInvoices(refreshed));
      }
    }

    return NextResponse.json({ invoices });
  } catch (error) {
    serverLogger.error("Failed to fetch invoices:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
