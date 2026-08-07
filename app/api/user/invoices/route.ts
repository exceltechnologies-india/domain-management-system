import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { listUserInvoiceOrders } from "@/lib/services/orders";
import { serverLogger } from "@/lib/server-logger";
import { selfHealUserInvoices } from "@/lib/zoho-invoice-retry";
import { getBillingInvoices } from "@/lib/integrations/billing-customer";
import { resolveUserBillingCustomerId } from "@/lib/services/users";

export const dynamic = "force-dynamic";

const ORDER_STATUS_TO_INVOICE: Record<string, string> = {
  completed: "paid",
  paid:      "paid",
  pending:   "sent",
  processing:"sent",
  failed:    "void",
  refunded:  "void",
};

// Sentinel values written by the invoice-creation flow — not real invoice IDs
const INVOICE_SENTINEL = new Set(["pending_creation", "creation_failed"]);

type OrderRow = Awaited<ReturnType<typeof listUserInvoiceOrders>>[number];

function mapOrdersToInvoices(orders: OrderRow[]) {
  let hasStuck = false;
  const invoices = orders.map((order) => {
    // Billing Panel (ResellerOS) is the live path going forward; Zoho is the
    // legacy fallback for invoices created before the cutover.
    const rawBillingId = order.billingInvoiceId as string | undefined;
    const rawZohoId = order.zohoInvoiceId as string | undefined;
    const invoiceId =
      rawBillingId && !INVOICE_SENTINEL.has(rawBillingId)
        ? rawBillingId
        : rawZohoId && !INVOICE_SENTINEL.has(rawZohoId)
          ? rawZohoId
          : "";
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

    // Billing-native invoices — created directly in Billing's own UI (e.g.
    // by staff), so there's no Customer Panel Order row for them at all.
    // Without this fetch they'd never appear here even though they're real,
    // paid invoices for this customer.
    const billingCustomerId = await resolveUserBillingCustomerId(user);
    if (billingCustomerId) {
      const knownIds = new Set(invoices.map((inv) => inv.invoice_id).filter(Boolean));
      const billingInvoices = await getBillingInvoices(billingCustomerId);
      for (const inv of billingInvoices) {
        if (knownIds.has(inv.id)) continue; // already surfaced via an Order row
        invoices.push({
          invoice_id: inv.id,
          invoice_number: inv.number,
          date: inv.issue_date,
          due_date: inv.due_date,
          total: inv.amount,
          balance: inv.status === "paid" ? 0 : inv.amount,
          status: inv.status,
          currency_code: inv.currency,
          created_time: inv.issue_date,
          zoho_pending: false,
        });
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
