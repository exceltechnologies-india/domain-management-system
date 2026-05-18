import { NextResponse } from "next/server";
import { DirectAdminService } from "@/lib/directadmin";
import { ZohoBooksService } from "@/lib/zohobooks";
import { EmailService } from "@/lib/email";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import type { IOrder } from "@/models/Order";
import { findUserHosting, listHostingsForUser } from "@/lib/services/hostings";
import { getCurrentDate } from "@/lib/dateUtils";
import { serverLogger } from "@/lib/server-logger";
import type { IUser } from "@/models/User";
import type { RazorpayPaymentDetails } from "@/lib/types";

export interface RenewalContext {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_subscription_id?: string;
  paymentDetails: RazorpayPaymentDetails;
  user: IUser;
}

/**
 * Handles renewal and invoice-payment flows.
 * Returns a NextResponse if the payment is a renewal (early exit),
 * or null if it should fall through to the normal new-order flow.
 */
export async function handleRenewalPayment(
  ctx: RenewalContext
): Promise<NextResponse | null> {
  const { razorpay_order_id, razorpay_payment_id, paymentDetails, user } = ctx;

  const isRenewal =
    razorpay_order_id.startsWith("ord_renew_") ||
    razorpay_order_id.startsWith("rnw_") ||
    paymentDetails?.notes?.type === "invoice_payment";

  if (!isRenewal) return null;

  serverLogger.info(
    `🔄 [PAYMENT-VERIFY] Detected Renewal/Invoice Payment. Reason: ${
      paymentDetails?.notes?.type || "ID Prefix"
    }`
  );
  await connectDB();

  let renewalOrder = await Order.findOne({
    $or: [
      { razorpayOrderId: razorpay_order_id },
      { orderId: razorpay_order_id },
    ],
  });

  const zohoService = ZohoBooksService.getInstance();
  let invoiceId = paymentDetails?.notes?.invoice_id;

  // 1. Create and Pay Zoho Invoice
  if (!invoiceId && renewalOrder) {
    try {
      serverLogger.info(
        `📊 [PAYMENT-VERIFY] Creating Zoho Invoice for renewal order: ${renewalOrder.orderId}`
      );

      const invoiceItems = renewalOrder.domains.map((d: IOrder['domains'][number]) => ({
        itemType: d.itemType || "domain",
        domainName: d.domainName,
        price: d.price,
        registrationPeriod: d.registrationPeriod || 1,
        periodUnit:
          d.periodUnit || (d.itemType === "hosting" ? "months" : "years"),
        hostingPlan: d.hostingPlan,
      }));

      const invoice = await zohoService.createInvoice(
        {
          orderId: renewalOrder.orderId,
          razorpayPaymentId: razorpay_payment_id,
          total: paymentDetails.amount,
        },
        user,
        invoiceItems,
        "Razorpay",
        true
      );

      if (invoice && invoice.invoice_id) {
        invoiceId = invoice.invoice_id;
        renewalOrder.zohoInvoiceId = invoice.invoice_id;
        renewalOrder.invoiceNumber = invoice.invoice_number;
        await renewalOrder.save();
        serverLogger.info(
          `✅ [PAYMENT-VERIFY] Zoho Invoice created and paid for renewal: ${invoiceId}`
        );
      }
    } catch (err: any) {
      serverLogger.error(
        `❌ [PAYMENT-VERIFY] Failed to create Zoho Invoice for renewal:`,
        err.message
      );
    }
  } else if (invoiceId) {
    try {
      const success = await zohoService.applyPaymentToInvoice(
        invoiceId,
        Math.round(paymentDetails.amount) / 100,
        "Razorpay",
        razorpay_payment_id
      );
      if (success) {
        serverLogger.info(
          `✅ [PAYMENT-VERIFY] Existing Zoho Invoice ${invoiceId} marked as paid`
        );
      }
    } catch (err: any) {
      serverLogger.error(
        `❌ [PAYMENT-VERIFY] Failed to apply payment to existing Zoho Invoice ${invoiceId}:`,
        err.message
      );
    }
  }

  // 2. Reactivate Hosting and Extend Expiry
  try {
    if (renewalOrder && renewalOrder.domains) {
      for (const item of renewalOrder.domains) {
        if (item.itemType === "hosting") {
          const domainName = item.domainName;
          const hosting = await findUserHosting(String(user.id || user._id), {
            domainName,
          });

          if (hosting) {
            serverLogger.info(
              `🔓 [PAYMENT-VERIFY] Un-suspending targeted hosting: ${hosting.domainName}`
            );

            const needsUnsuspend = ["expired", "suspended"].includes(
              hosting.status
            );
            if (needsUnsuspend && hosting.directAdminUsername) {
              try {
                await DirectAdminService.unsuspendUser(
                  hosting.directAdminUsername
                );
              } catch (daErr: any) {
                serverLogger.error(
                  `⚠️ [PAYMENT-VERIFY] DirectAdmin unsuspend failed for ${domainName}, proceeding with DB update:`,
                  daErr.message
                );
              }
            }

            const now = getCurrentDate();
            const baseDate =
              hosting.expiryDate &&
              hosting.expiryDate.getTime() > now.getTime()
                ? new Date(hosting.expiryDate.getTime())
                : new Date(now);
            const newExpiry = baseDate;

            if (item.periodUnit === "minutes") {
              newExpiry.setMinutes(
                newExpiry.getMinutes() + (item.registrationPeriod || 1)
              );
            } else if (item.periodUnit === "days") {
              newExpiry.setDate(
                newExpiry.getDate() + (item.registrationPeriod || 8)
              );
            } else if (item.periodUnit === "years") {
              newExpiry.setFullYear(
                newExpiry.getUTCFullYear() + (item.registrationPeriod || 1)
              );
            } else {
              newExpiry.setUTCMonth(
                newExpiry.getUTCMonth() + (item.registrationPeriod || 1)
              );
            }

            hosting.status = "active";
            hosting.expiryDate = newExpiry;
            hosting.paymentId = razorpay_payment_id;
            // renewalInvoiceId / renewalStatus are stored on Hosting but not
            // in IHosting's typed shape — they're written by the Zoho-driven
            // renewal flow and inspected by ops dashboards.
            (hosting as unknown as { renewalInvoiceId?: string; renewalStatus?: string }).renewalInvoiceId = invoiceId;
            (hosting as unknown as { renewalInvoiceId?: string; renewalStatus?: string }).renewalStatus = "paid";
            hosting.last_reminder_sent = null;
            hosting.next_action_at = new Date(
              newExpiry.getTime() - 15 * 24 * 60 * 60 * 1000
            );

            await hosting.save();
            serverLogger.info(
              `✅ [PAYMENT-VERIFY] Hosting ${hosting.domainName} renewed until ${newExpiry}`
            );

            try {
              await EmailService.sendHostingProvisionedEmail(
                user.email,
                user.firstName || "User",
                {
                  domainName: hosting.domainName,
                  planName: hosting.name || "Hosting Plan",
                  serverIp:
                    process.env.DIRECTADMIN_IP || "136.115.64.54",
                  nameservers: DirectAdminService.NAMESERVERS,
                  status: "Reactivated",
                } as any
              );
            } catch (_e) {}
          }
        }
      }
    } else {
      // Fallback: broad reactivation if no order found
      serverLogger.info(
        "⚠️ [PAYMENT-VERIFY] No specific renewal order found, applying fallback reactivation"
      );
      const userHostings = await listHostingsForUser(String(user.id || user._id));
      for (const hosting of userHostings) {
        // "suspended" isn't in IHosting's typed enum but production data has
        // it (written by the daily-scheduler when accounts lapse). Widen the
        // comparison rather than narrow the model's enum.
        const status = hosting.status as string;
        if (status === "suspended" || status === "expired") {
          if (hosting.directAdminUsername) {
            await DirectAdminService.unsuspendUser(
              hosting.directAdminUsername
            );
          }
          const now = getCurrentDate();
          const newExpiry = new Date(now);
          newExpiry.setMonth(newExpiry.getMonth() + 1);

          hosting.status = "active";
          hosting.expiryDate = newExpiry;
          hosting.paymentId = razorpay_payment_id;
          await hosting.save();
        }
      }
    }
  } catch (err: any) {
    serverLogger.error(
      "❌ [PAYMENT-VERIFY] Reactivation logic failed:",
      err.message
    );
  }

  // 3. Mark Order as Completed
  if (renewalOrder) {
    try {
      renewalOrder.status = "completed";
      renewalOrder.razorpayPaymentId = razorpay_payment_id;
      if (renewalOrder.domains && renewalOrder.domains.length > 0) {
        renewalOrder.domains.forEach((d: IOrder['domains'][number]) => {
          d.status = "registered";
        });
      }
      await renewalOrder.save();
      serverLogger.info(
        `✅ [PAYMENT-VERIFY] Renewal Order ${razorpay_order_id} marked as COMPLETED.`
      );
    } catch (orderErr: any) {
      serverLogger.error(
        "❌ [PAYMENT-VERIFY] Failed to update renewal order status:",
        orderErr.message
      );
    }
  }

  return NextResponse.json({
    success: true,
    message: "Payment verified, services reactivated.",
    orderId: razorpay_order_id,
  });
}
