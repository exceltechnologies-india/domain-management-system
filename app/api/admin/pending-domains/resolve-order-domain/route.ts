import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import { getOrderByOrderId } from "@/lib/services/orders";
import type { IOrder } from "@/models/Order";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { getDomainOrderId as rcGetDomainOrderId } from "@/lib/integrations/resellerclub";
import { validatedBody, z } from "@/lib/api-validation";

// Resolve an ORDER-SOURCED pending-domain row. These rows are a live
// projection of Orders that still have a domain in `pending`/`processing`
// status — they have NO PendingDomain document, so the per-row
// register/retry/archive/delete actions (which operate on PendingDomain)
// don't apply. This endpoint lets an admin close out such a stuck in-flight
// domain by flipping the ORDER's domain status to `failed` (or `cancelled`
// when also cancelled at ResellerClub). Once the domain is no longer
// pending/processing it drops off the in-flight projection
// (`listOrdersWithInFlightDomains` filters on those two statuses).
const resolveOrderDomainSchema = z.object({
  orderId: z.string().min(1),
  domainName: z.string().trim().toLowerCase().min(3).max(253),
  // When true, also attempt to cancel the domain order at ResellerClub
  // before marking it. The mark still proceeds even if the registrar call
  // fails (best-effort), so the admin isn't blocked by a flaky RC API.
  cancelAtRegistrar: z.boolean().optional(),
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const reqId = Math.random().toString(36).slice(2, 8);
  try {
    await connectDB();

    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, resolveOrderDomainSchema);
    if (!validation.ok) return validation.response;
    const { orderId, domainName, cancelAtRegistrar } = validation.data;

    const order = await getOrderByOrderId(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const domainIndex = order.domains.findIndex(
      (d: IOrder["domains"][number]) =>
        (d.domainName || "").toLowerCase() === domainName
    );
    if (domainIndex === -1) {
      return NextResponse.json(
        { error: "Domain not found on this order" },
        { status: 404 }
      );
    }

    const domain = order.domains[domainIndex];
    // Only in-flight domains can be resolved here. A domain that already
    // completed/failed/cancelled isn't shown in the in-flight list anyway;
    // guard so a stale/replayed request can't clobber a settled domain.
    if (domain.status !== "pending" && domain.status !== "processing") {
      return NextResponse.json(
        {
          error: `Domain is '${domain.status}', not in-flight — nothing to resolve.`,
        },
        { status: 400 }
      );
    }

    // Optional registrar cancellation (best-effort).
    let registrarCancelled = false;
    let registrarMessage = "";
    if (cancelAtRegistrar) {
      let rcOrderId = domain.resellerClubOrderId;
      if (!rcOrderId) {
        try {
          const searchOutcome = await rcGetDomainOrderId({ domainName });
          if (searchOutcome.kind === "found") rcOrderId = searchOutcome.orderId;
        } catch (searchErr) {
          serverLogger.warn(
            `[${reqId}] RC order-id search failed for ${domainName}:`,
            searchErr
          );
        }
      }
      if (rcOrderId) {
        try {
          const rcResult = await ResellerClubWrapper.deleteDomainOrder(rcOrderId);
          if (rcResult.status === "success") {
            registrarCancelled = true;
          } else {
            registrarMessage = rcResult.message || "Registrar cancellation failed";
          }
        } catch (rcErr: unknown) {
          registrarMessage =
            rcErr instanceof Error ? rcErr.message : "Registrar API error";
          serverLogger.error(
            `[${reqId}] RC deleteDomainOrder threw for ${domainName}:`,
            rcErr
          );
        }
      } else {
        registrarMessage = "No ResellerClub order id found to cancel";
      }
    }

    // Mark the order's domain. `cancelled` when we confirmed a registrar
    // cancellation, otherwise `failed` (admin closed out a stuck domain).
    const newStatus = registrarCancelled ? "cancelled" : "failed";
    order.domains[domainIndex].status = newStatus;
    order.domains[domainIndex].bookingStatus =
      order.domains[domainIndex].bookingStatus || [];
    order.domains[domainIndex].bookingStatus.push({
      step: "domain_failed",
      message:
        `Marked ${newStatus} by admin (resolved from Pending Domains)` +
        (registrarCancelled ? " — confirmed cancelled at registrar" : "") +
        (registrarMessage ? ` — registrar: ${registrarMessage}` : ""),
      timestamp: new Date(),
      progress: 0,
    });
    order.markModified("domains");
    await order.save();

    serverLogger.info(
      `[${reqId}] Resolved order-sourced domain ${domainName} on order ${orderId} → ${newStatus}` +
        (cancelAtRegistrar ? ` (registrarCancelled=${registrarCancelled})` : "")
    );

    return NextResponse.json({
      success: true,
      message: `${domainName} marked as ${newStatus}.`,
      status: newStatus,
      registrarCancelled,
      registrarMessage: registrarMessage || undefined,
    });
  } catch (error) {
    serverLogger.error(
      `[${reqId}] [ADMIN-RESOLVE-ORDER-DOMAIN] error:`,
      error instanceof Error ? error.message : String(error)
    );
    return NextResponse.json(
      { success: false, error: "Unable to resolve the order domain. Please try again." },
      { status: 500 }
    );
  }
}
