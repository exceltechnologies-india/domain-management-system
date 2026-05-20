import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import PendingDomain from "@/models/PendingDomain";
import type { IOrder } from "@/models/Order";
import { getOrderByOrderId, recordZohoInvoiceForOrder } from "@/lib/services/orders";
import { getUserById, getUserByIdSafe } from "@/lib/services/users";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { DomainVerificationService } from "@/lib/domain-verification";
import { EmailService } from "@/lib/email";
import { getToken } from "next-auth/jwt";
import { serverLogger } from "@/lib/server-logger";
import { ZohoBooksService } from "@/lib/zohobooks";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectDB();

    const { id } = await params;

    // Verify admin authentication
    let user = await AuthService.getUserFromRequest(request);
    if (!user) {
      const token = await getToken({ 
        req: request,
        secret: AUTH_SECRET,
      });
      if (token?.id) {
        user = await getUserByIdSafe(token.id);
      }
    }

    if (!user || user.role !== "admin" || !user.isActive) {
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

        // --- ZOHO BOOKS SYNC ---
        try {
          const syncOrder = await getOrderByOrderId(pendingDomain.orderId);
          const syncUser = await getUserById(pendingDomain.userId);

          if (syncUser && syncOrder && (!syncOrder.zohoInvoiceId || syncOrder.zohoInvoiceId === 'pending_creation')) {
            const zohoService = ZohoBooksService.getInstance();
            const invoiceItems = syncOrder.domains.map((d: IOrder['domains'][number]) => ({
                itemType: d.itemType || 'domain',
                domainName: d.domainName,
                price: d.price,
                registrationPeriod: d.registrationPeriod || 1,
                periodUnit: d.periodUnit || (d.itemType === 'hosting' ? 'months' : 'years'),
                hostingPlan: d.hostingPlan
            }));

            const invoice = await zohoService.createInvoice(
                {
                    orderId: syncOrder.orderId,
                    razorpayPaymentId: syncOrder.razorpayPaymentId || syncOrder.paymentId,
                    total: syncOrder.amount
                },
                syncUser,
                invoiceItems,
                'Razorpay',
                true
            );

            if (invoice?.invoice_id) {
                await recordZohoInvoiceForOrder(String(syncOrder._id), {
                    invoiceId: invoice.invoice_id,
                    invoiceNumber: invoice.invoice_number,
                });
            }
          }
        } catch (e) {
          serverLogger.error("Zoho sync failed in manual registration:", e);
        }

        return NextResponse.json({ success: true, message: "Domain registered successfully", result, pendingDomain });
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
