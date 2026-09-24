import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";
import {
  getOrderByIdOrOrderId,
  markInvoiceCreationFailed,
} from "@/lib/services/orders";
import { getUserById } from "@/lib/services/users";
import { createPrimaryInvoice } from "@/lib/services/billing/createPrimaryInvoice";
import { cartItemsFromOrderDomains } from "@/lib/services/payment/order-creator";
import type { RazorpayPaymentDetails } from "@/lib/types";

// Force dynamic rendering
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/orders/[id]/re-sync-invoice
 *
 * Admin "issue the invoice now" for a paid order that has none. Goes through
 * `createPrimaryInvoice`, the same chokepoint as every other call site — until
 * Zoho Books was removed (24 Sep 2026) this route called Zoho directly, the
 * one invoicing path that bypassed the chokepoint.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const adminUser = await AuthService.getAdminFromRequest(request);
    if (!adminUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const order = await getOrderByIdOrOrderId(id);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    serverLogger.info(`📂 [ADMIN] Manual invoice issue triggered for order ${order.orderId} by admin ${adminUser.email}`);

    // ── Double-billing guard ────────────────────────────────────────────────
    // Any `invoiceProvider` — our engine's, or a historical Zoho one — means
    // this payment already has a tax invoice. A second would put two invoices
    // for one supply into GSTR-1. The engine's own claim refuses this too;
    // checking here gives the admin a reason instead of a silent skip.
    if (order.invoiceProvider) {
      serverLogger.warn(
        `🛑 [ADMIN] Invoice issue refused for order ${order.orderId} — already invoiced (${order.invoiceProvider}, ${order.invoiceNumber || 'no number recorded'})`
      );
      return NextResponse.json(
        {
          error:
            `Order ${order.orderId} already has a tax invoice` +
            `${order.invoiceNumber ? ` (${order.invoiceNumber})` : ''}. ` +
            `Issuing another would bill the same payment twice. ` +
            `Nothing to do — open the invoice from Admin → Invoices.`,
          code: 'INVOICE_EXISTS',
          invoiceProvider: order.invoiceProvider,
          invoice_number: order.invoiceNumber,
        },
        { status: 409 }
      );
    }

    const user = await getUserById(String(order.userId));
    if (!user) {
      return NextResponse.json({ error: "Associated user not found" }, { status: 404 });
    }

    const paymentId = order.razorpayPaymentId || order.paymentId || "";
    try {
      const result = await createPrimaryInvoice(
        {
          order,
          orderId: order.orderId,
          razorpay_payment_id: paymentId,
          paymentDetails: {
            id: paymentId,
            amount: order.amount,
            currency: order.currency || "INR",
          } as RazorpayPaymentDetails,
          user,
          cartItems: cartItemsFromOrderDomains(order.domains || []),
        },
        // An admin reaches for this precisely when an earlier attempt died, so
        // an abandoned claim must not block it. 5 min matches the other
        // recovery paths; a COMPLETED invoice can never be stolen.
        { claimOptions: { staleClaimAfterMs: 5 * 60 * 1000 } }
      );

      if (result.provider === "skipped") {
        return NextResponse.json(
          {
            success: false,
            error:
              "No invoice was issued: this is a ₹0/trial order (not invoiced by policy), " +
              "or another request is issuing it right now. Refresh in a minute to check.",
          },
          { status: 409 }
        );
      }

      serverLogger.info(`✅ [ADMIN] Invoice ${result.invoiceNumber} issued for ${order.orderId}`);
      return NextResponse.json({
        success: true,
        message: `Invoice ${result.invoiceNumber} issued`,
        invoice_id: order.orderId,
        invoice_number: result.invoiceNumber,
      });
    } catch (issueErr: unknown) {
      const message = issueErr instanceof Error ? issueErr.message : String(issueErr);
      await markInvoiceCreationFailed(order._id, message).catch(() => {});
      serverLogger.error(`❌ [ADMIN] Invoice issue failed for ${order.orderId}: ${message}`);
      return NextResponse.json(
        {
          success: false,
          error:
            `The invoice could not be issued: ${message}. ` +
            `Fix the cause (for example COMPANY_STATE on the server, or the customer's billing state) and press Re-sync again.`,
        },
        { status: 500 }
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error(`❌ [ADMIN] Error in manual invoice-issue route:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
