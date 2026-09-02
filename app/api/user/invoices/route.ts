import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { listUserInvoiceOrders } from "@/lib/services/orders";
import { serverLogger } from "@/lib/server-logger";
import { selfHealUserInvoices } from "@/lib/zoho-invoice-retry";

export const dynamic = "force-dynamic";

const ORDER_STATUS_TO_INVOICE: Record<string, string> = {
  completed: "paid",
  paid:      "paid",
  pending:   "sent",
  processing:"sent",
  failed:    "void",
  refunded:  "void",
};

// Sentinel values written by the invoice-creation flow — not real Zoho IDs
const ZOHO_SENTINEL = new Set(["pending_creation", "creation_failed"]);

type OrderRow = Awaited<ReturnType<typeof listUserInvoiceOrders>>[number];

function mapOrdersToInvoices(orders: OrderRow[]) {
  let hasStuck = false;
  const invoices = orders.map((order) => {
    const rawZohoId = order.zohoInvoiceId as string | undefined;
    const invoiceId = rawZohoId && !ZOHO_SENTINEL.has(rawZohoId) ? rawZohoId : "";
    const isPaid = ["completed", "paid"].includes(order.status as string);
    const date = (order.createdAt as Date).toISOString();
    // An order billed by the primary GST engine carries a real, issued tax
    // invoice and has NO zohoInvoiceId by design. It must not be reported as
    // "generating…", and must not be handed to the Zoho self-heal below —
    // that would issue a SECOND tax invoice for the same payment.
    const isPrimary = order.invoiceProvider === "primary";
    if (!invoiceId && isPaid && !isPrimary) hasStuck = true;

    return {
      invoice_id:     invoiceId,
      invoice_number: order.invoiceNumber as string,
      date,
      due_date:       date,
      total:          order.amount as number,
      balance:        isPaid ? 0 : (order.amount as number),
      status:         ORDER_STATUS_TO_INVOICE[order.status as string] ?? "draft",
      currency_code:  order.currency as string,
      created_time:   date,
      // Which engine issued it — tells the client where the PDF lives: a
      // 'primary' invoice downloads via the orderId-keyed route, a Zoho one
      // via the zohoInvoiceId-keyed route.
      provider:       isPrimary ? "primary" : "zoho",
      order_id:       order.orderId as string,
      // Surface to the client so it can render a "Generating invoice…"
      // pill instead of the empty-action fallback.
      zoho_pending:   !invoiceId && isPaid && !isPrimary,
    };
  });
  return { invoices, hasStuck };
}

export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orders = await listUserInvoiceOrders(user._id);
    let { invoices, hasStuck } = mapOrdersToInvoices(orders);

    // Self-heal: retry Zoho invoice creation for any paid orders whose
    // bookkeeping step never completed. Runs inline (awaited) because
    // Cloud Run throttles CPU after the response is sent — fire-and-forget
    // promises die mid-call. The retry itself is gated by a 5-min Redis
    // throttle per order, so reloads within the window are no-ops (~10ms).
    if (hasStuck) {
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
