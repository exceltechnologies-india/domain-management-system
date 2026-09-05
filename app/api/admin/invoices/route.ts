import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { ZohoBooksService } from "@/lib/zohobooks";
import connectDB from "@/lib/mongodb";
import { serverLogger } from "@/lib/server-logger";
import { listPrimaryInvoiceOrdersAdmin } from "@/lib/services/orders";

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
 * GET /api/admin/invoices?source=zoho|primary
 *
 * Two independently-paginated sources, selected by `source`:
 *
 *  - `zoho` (DEFAULT, unchanged) — straight passthrough to Zoho Books. This
 *    is the accounting system's own view and includes invoices raised
 *    directly in Zoho that have no Order behind them at all.
 *
 *  - `primary` — invoices minted by our own GST engine (`TI/YYYY-YY/NNNNN`).
 *    These exist ONLY in our database; Zoho never sees them, so before this
 *    branch existed they were completely invisible to the admin — no lookup,
 *    no download, for a bill the customer legally holds.
 *
 * They are NOT merged into one list on purpose. Zoho paginates server-side,
 * so producing a single correctly-ordered interleaved page would mean pulling
 * every Zoho page on every request. Tabs keep both page counts honest instead
 * of showing a merged list whose pagination silently repeats or skips rows.
 *
 * Both branches return the same row shape so the page renders one table. The
 * `provider` + `order_id` fields tell the client where a row's PDF lives —
 * mirroring what `/api/user/invoices` already returns to the customer panel.
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
    // Anything that isn't an explicit "primary" keeps the historical Zoho
    // behaviour, so an older client with no `source` param is unaffected.
    const source = searchParams.get("source") === "primary" ? "primary" : "zoho";

    if (source === "primary") {
      const { orders, hasMore, total } = await listPrimaryInvoiceOrdersAdmin(page, perPage);
      serverLogger.info(
        `[AdminAPI] fetching primary-engine invoices from the local DB (page ${page}, ${orders.length} rows)`
      );

      const invoices = orders.map((order) => {
        const date = (order.createdAt as Date).toISOString();
        const isPaid = ["completed", "paid"].includes(order.status as string);
        return {
          // A primary invoice has no external gateway id. Left empty so any
          // consumer keying off it fails visibly rather than fetching the
          // wrong document; the client routes on `provider`/`order_id`.
          invoice_id:     "",
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
          provider:       "primary",
          order_id:       order.orderId as string,
        };
      });

      return NextResponse.json({
        success: true,
        invoices,
        // `total` is a REAL count here (our own collection). The Zoho branch
        // below can only pass through whatever Zoho sent, which often omits
        // it — the admin table renders a cursor-style pager in that case
        // rather than inventing a number.
        page_context: { page, per_page: perPage, has_more_page: hasMore, total },
      });
    }

    serverLogger.info('[AdminAPI] fetching invoices via Zoho service. OrgID:', process.env.ZOHO_ORG_ID);
    const zohoService = ZohoBooksService.getInstance();
    const result = await zohoService.getAllInvoices(page, perPage);

    return NextResponse.json({
        success: true,
        invoices: result.invoices.map((inv) => ({
          ...inv,
          // Stamped so the client can route actions uniformly across tabs
          // without inferring the provider from an empty id.
          provider: "zoho",
        })),
        page_context: result.page_context
    });

  } catch (error) {
    serverLogger.error("Failed to fetch admin invoices:", error);
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 }
    );
  }
}
