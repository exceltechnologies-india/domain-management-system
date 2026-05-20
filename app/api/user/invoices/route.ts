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

export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orders = await listUserInvoiceOrders(user._id);

    let hasStuck = false;
    const invoices = orders.map((order) => {
      const rawZohoId = order.zohoInvoiceId as string | undefined;
      const invoiceId = rawZohoId && !ZOHO_SENTINEL.has(rawZohoId) ? rawZohoId : "";
      const isPaid = ["completed", "paid"].includes(order.status as string);
      const date = (order.createdAt as Date).toISOString();
      if (!invoiceId && isPaid) hasStuck = true;

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
        // Surface to the client so it can render a "Generating invoice…"
        // pill instead of the empty-action fallback.
        zoho_pending:   !invoiceId && isPaid,
      };
    });

    // Self-heal: kick off a background retry for any paid orders whose Zoho
    // invoice never completed. Throttled (5 min/order) to avoid hammering Zoho
    // when the user reloads. Fire-and-forget — never blocks the response.
    if (hasStuck) {
      selfHealUserInvoices(String(user._id));
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
