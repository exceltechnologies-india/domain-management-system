import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import PendingDomain from "@/models/PendingDomain";
import type { IOrder } from "@/models/Order";
import { getOrderByOrderId } from "@/lib/services/orders";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { classifyRegisterDomainResponse } from "@/lib/integrations/resellerclub/classify";
import type { RegisterDomainOutcome } from "@/lib/integrations/resellerclub/types";
import { DomainVerificationService } from "@/lib/domain-verification";
import { EmailService } from "@/lib/email";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
/**
 * Outcomes that mean "the registrar has this in hand", not "it failed".
 * Kept as a named set so the branch below reads as a question about intent
 * rather than a string comparison, and so adding an outcome to the union
 * forces a decision here.
 */
const RETRYABLE_OUTCOMES = new Set<RegisterDomainOutcome["kind"]>([
  "balance_pending",
  "already_in_progress",
]);

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectDB();

    const { id } = await params;

    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pendingDomain = await PendingDomain.findById(id);
    if (!pendingDomain) {
      return NextResponse.json({ error: "Pending domain not found" }, { status: 404 });
    }

    if (pendingDomain.status !== "pending") {
      return NextResponse.json({ error: "Domain is not in pending status" }, { status: 400 });
    }

    pendingDomain.status = "processing";
    await pendingDomain.save();

    try {
      const result = await ResellerClubWrapper.registerDomain(
        pendingDomain.domainName,
        pendingDomain.registrationPeriod,
        pendingDomain.customerId,
        pendingDomain.nameServers,
        {
          admin: pendingDomain.adminContactId || pendingDomain.contactId,
          tech: pendingDomain.techContactId || pendingDomain.contactId,
          billing: pendingDomain.billingContactId || pendingDomain.contactId,
        },
        pendingDomain.tldAttributes
      );

      if (result.status === "success") {
        const expiresAt = new Date(Date.now() + pendingDomain.registrationPeriod * 365 * 24 * 60 * 60 * 1000);

        pendingDomain.status = "completed";
        pendingDomain.registeredAt = new Date();
        pendingDomain.expiresAt = expiresAt;
        pendingDomain.resellerClubOrderId = result.data?.orderid;
        pendingDomain.reason = "Domain registered successfully by admin";
        await pendingDomain.save();

        const order = await getOrderByOrderId(pendingDomain.orderId, { populate: { path: "userId", select: "email firstName lastName" } });
        if (order) {
          const domainIndex = order.domains.findIndex((d: IOrder['domains'][number]) => d.domainName === pendingDomain.domainName);
          if (domainIndex !== -1) {
            order.domains[domainIndex].status = "registered";
            order.domains[domainIndex].resellerClubOrderId = result.data?.orderid;
            order.domains[domainIndex].expiresAt = expiresAt;
            // `registeredAt` isn't on the typed subdoc but mongoose persists it
            // anyway via strict:false-style assignment; cast to bypass narrow type.
            (order.domains[domainIndex] as unknown as { registeredAt?: Date }).registeredAt = new Date();
            await order.save();

            const allDomainsRegistered = order.domains.every((d: IOrder['domains'][number]) => d.status === "registered");
            if (allDomainsRegistered && order.userId) {
              // Populated via .populate('userId', 'email firstName lastName')
              const orderUser = order.userId as unknown as {
                email: string;
                firstName: string;
                lastName: string;
              };
              const successfulDomains = order.domains
                .filter((d: IOrder['domains'][number]) => d.status === "registered")
                .map((d: IOrder['domains'][number]) => ({
                  domainName: d.domainName,
                  price: d.price,
                  registrationPeriod: d.registrationPeriod,
                  planName: d.hostingPlan?.name,
                }));

              const subtotal = (order.amount as number) / 1.18;
              try {
                await EmailService.sendOrderConfirmationEmail(
                  orderUser.email,
                  `${orderUser.firstName} ${orderUser.lastName}`,
                  {
                    orderId: order.orderId,
                    purchaseOrderNumber: order.purchaseOrderNumber || "",
                    invoiceNumber: order.invoiceNumber || "",
                    amount: order.amount,
                    subtotal: subtotal,
                    currency: order.currency || "INR",
                    successfulDomains,
                    allDomains: order.domains.map((d: IOrder['domains'][number]) => ({
                      domainName: d.domainName,
                      price: d.price,
                      registrationPeriod: d.registrationPeriod,
                      status: d.status,
                      planName: d.hostingPlan?.name,
                    })),
                    paymentId: order.paymentId || "",
                    createdAt: order.createdAt,
                  } as unknown as Parameters<typeof EmailService.sendOrderConfirmationEmail>[2]
                );
              } catch (e) {
                serverLogger.error("Order confirmation email failed:", e);
              }
            }
          }
        }

        // No invoice catch-up: DMS issues no bills (owner decision, 24 Sep 2026).
        // A paid order was flagged for billing in ResellerOS when it was paid.

        return NextResponse.json({ success: true, message: "Domain registered successfully", result, pendingDomain });
      } else if (RETRYABLE_OUTCOMES.has(classifyRegisterDomainResponse(result).kind)) {
        /**
         * NOT a failure. ResellerClub is saying the registration is QUEUED
         * (insufficient reseller balance, a processing lock) or already in
         * flight for this name.
         *
         * This branch did not exist until 2026-09-21: anything that was not
         * `status === "success"` was written as `failed`, destroying the only
         * record that a name was in progress. `classifyRegisterDomainResponse`
         * maps a raw `status: "pending"` straight to `balance_pending`, so the
         * commonest queued case landed in the failure branch verbatim.
         *
         * The harm is what an admin does next. A row reading "Registration
         * failed" invites a refund, or a second manual attempt on a name the
         * registrar may be about to register — and a double registration is
         * money that does not come back.
         *
         * Back to `pending` so the sweeper drains it, with a reason that says
         * queued rather than failed. This is the same classifier the payment
         * provisioner uses, so the two paths now agree about what RC said.
         */
        pendingDomain.status = "pending";
        pendingDomain.reason = `Queued at the registrar, not failed: ${result.message}`;
        await pendingDomain.save();

        serverLogger.warn(
          `[ADMIN-REGISTER] ${pendingDomain.domainName} is queued at ResellerClub; left pending for the sweeper: ${result.message}`
        );

        return NextResponse.json(
          {
            success: false,
            status: "pending",
            message:
              "ResellerClub queued this registration rather than rejecting it — usually " +
              "reseller balance or a processing lock. It stays in the pending list and the " +
              "sweeper will retry it. Do not register it again by hand: the name may " +
              "already be in flight.",
            error: result.message,
            pendingDomain,
          },
          { status: 202 }
        );
      } else {
        pendingDomain.status = "failed";
        pendingDomain.reason = `Registration failed: ${result.message}`;
        await pendingDomain.save();

        const order = await getOrderByOrderId(pendingDomain.orderId);
        if (order) {
          const idx = order.domains.findIndex((d: IOrder['domains'][number]) => d.domainName === pendingDomain.domainName);
          if (idx !== -1) {
            order.domains[idx].status = "failed";
            order.domains[idx].error = `Admin manual registration failed: ${result.message}`;
            order.markModified("domains");
            await order.save();
          }
        }

        return NextResponse.json({ success: false, message: "Domain registration failed", error: result.message, pendingDomain }, { status: 400 });
      }
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : String(error);
      pendingDomain.status = "failed";
      pendingDomain.reason = `Registration error: ${errMessage}`;
      await pendingDomain.save();
      return NextResponse.json({ success: false, message: "Domain registration error", error: errMessage, pendingDomain }, { status: 500 });
    }
  } catch (error: unknown) {
    serverLogger.error("Critical error in admin register:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
