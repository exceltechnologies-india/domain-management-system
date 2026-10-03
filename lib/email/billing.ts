import { sendEmail, SUPPORT_EMAIL } from "./transporter";
import { formatIndianDateTime } from "../dateUtils";
import { brandName, firstName, plainEmailHtml } from "./plain";

/*
 * Order emails to the customer, in the ResellerOS pattern (lib/email/plain.ts; Pawan,
 * 3 Oct 2026). Rewritten from the earlier banner-and-table layout so a customer gets the
 * same plain, signed email from DMS as from ResellerOS. What each one SAYS is unchanged:
 * the order, PO, invoice and payment ids, the date, every line with its price and period,
 * the subtotal / GST / total, the refund promise when registration failed, and where to get
 * help. The two staff emails further down (admin notification, low balance) are not
 * customer-facing and keep their own layout.
 */

function send(to: string, subject: string, text: string): Promise<boolean> {
  return sendEmail({ to, subject, text, html: plainEmailHtml(text) });
}

function helpLines(): string {
  return `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.\n\n— ${brandName()}`;
}

function periodLabel(n: number, unit: string = "year"): string {
  return `${n} ${unit}${n !== 1 ? "s" : ""}`;
}

export async function sendPurchaseOrderEmail(
  userEmail: string,
  userName: string,
  orderData: {
    orderId: string;
    purchaseOrderNumber: string;
    invoiceNumber: string;
    amount: number;
    subtotal: number;
    currency: string;
    paymentStatus: "success" | "failed";
    registrationFailed?: boolean;
    paymentId: string;
    createdAt: Date;
    domains: Array<{
      domainName: string;
      price: number;
      registrationPeriod: number;
      periodUnit?: "month" | "year";
      planName?: string;
      itemType?: "domain" | "hosting";
    }>;
  }
): Promise<boolean> {
  const po = orderData.purchaseOrderNumber;
  const paid = orderData.paymentStatus === "success";
  const registrationFailed = paid && orderData.registrationFailed === true;

  let subject: string;
  let opening: string;
  let nextStep: string;

  if (registrationFailed) {
    subject = `Payment received, but registration failed — purchase order ${po}`;
    opening = `We received your payment, but the domain registration failed for technical reasons. Purchase order ${po} has been generated, and a refund to your original payment method will be initiated within 2-10 business days.`;
    nextStep = "Nothing more is needed from you — the refund is processed automatically.";
  } else if (paid) {
    subject = `Payment received — purchase order ${po}`;
    opening = `Thank you for your purchase. We received your payment and generated purchase order ${po}. Your domain registration is being processed.`;
    nextStep = "You'll get another email once your domains are registered.";
  } else {
    subject = `Your payment didn't go through — purchase order ${po}`;
    opening = `Your payment didn't go through. Purchase order ${po} has been generated, but the order can't go ahead until it is paid.`;
    nextStep = `To complete your payment and go ahead with the registration, reply to this email or write to ${SUPPORT_EMAIL}.`;
  }

  const lines = orderData.domains
    .map((d) => {
      const unit = d.periodUnit || "year";
      const plan = d.itemType === "hosting" || d.planName ? ` (${d.planName || "Hosting Plan"})` : "";
      return `  ${d.domainName}${plan} — ${periodLabel(d.registrationPeriod, unit)} at ₹${d.price.toFixed(2)}/${unit} — ₹${(d.price * d.registrationPeriod).toFixed(2)}`;
    })
    .join("\n");

  const gstAmount = orderData.amount - orderData.subtotal;
  const gstPercent =
    orderData.subtotal > 0
      ? ((gstAmount / orderData.subtotal) * 100).toFixed(0)
      : "18";

  const details = [
    `  Purchase order: ${po}`,
    `  Order ID: ${orderData.orderId}`,
    `  Invoice number: ${orderData.invoiceNumber}`,
    `  Payment: ${paid ? "successful" : "failed"}`,
    ...(paid ? [`  Payment ID: ${orderData.paymentId}`] : []),
    `  Date: ${formatIndianDateTime(orderData.createdAt)}`,
  ].join("\n");

  const text =
`Hi ${firstName(userName)},

${opening}

${lines}

  Subtotal: ₹${orderData.subtotal.toFixed(2)}
  GST (${gstPercent}%): ₹${gstAmount.toFixed(2)}
  Total: ₹${orderData.amount.toFixed(2)} ${orderData.currency} (GST included)

${details}

${nextStep}

${helpLines()}`;

  return send(userEmail, subject, text);
}

export async function sendOrderConfirmationEmail(
  userEmail: string,
  userName: string,
  orderData: {
    orderId: string;
    purchaseOrderNumber: string;
    invoiceNumber: string;
    amount: number;
    currency: string;
    successfulDomains: Array<{
      domainName: string;
      price: number;
      registrationPeriod: number;
      planName?: string;
    }>;
    allDomains: Array<{
      domainName: string;
      price: number;
      registrationPeriod: number;
      status: string;
      planName?: string;
    }>;
    paymentId: string;
    createdAt: Date;
  }
): Promise<boolean> {
  const hasSuccessfulDomains = orderData.successfulDomains.length > 0;
  const hasPendingDomains = orderData.allDomains.some(
    (d) => d.status === "pending"
  );
  const hasOnlyPendingOrSuccessful = orderData.allDomains.every(
    (d) => d.status === "pending" || d.status === "registered"
  );
  const inv = orderData.invoiceNumber;

  let subject: string;
  let opening: string;

  if (hasSuccessfulDomains && !hasPendingDomains) {
    subject = `Your order is confirmed — invoice ${inv}`;
    opening = "Thank you for your purchase. Your order has been processed and all your domains are registered.";
  } else if (hasPendingDomains && hasOnlyPendingOrSuccessful) {
    subject = `Payment received — invoice ${inv}`;
    opening = "Thank you for your purchase. We received your payment, and your domain registration is being processed — it will be completed shortly.";
  } else if (hasSuccessfulDomains && hasPendingDomains) {
    subject = `Payment received — invoice ${inv}`;
    opening = "Thank you for your purchase. We received your payment. Some of your domains are registered, and the others are still being processed.";
  } else {
    subject = `Payment received — we're looking into your order, invoice ${inv}`;
    opening = "We received your payment, but ran into a problem registering your domains. Our team will contact you shortly — we're sorry for the trouble.";
  }

  const lines = orderData.allDomains
    .map((d) => {
      const status =
        d.status === "registered" ? "registered" : d.status === "pending" ? "processing" : "contact support";
      const plan = d.planName ? ` (${d.planName})` : "";
      return `  ${d.domainName}${plan} — ${periodLabel(d.registrationPeriod)} at ₹${d.price.toFixed(2)} — ₹${(d.price * d.registrationPeriod).toFixed(2)} — ${status}`;
    })
    .join("\n");

  const total = orderData.amount;
  const registeredLine = hasSuccessfulDomains
    ? `\n\n${orderData.successfulDomains.length} domain(s) registered successfully.`
    : "";
  const dashboardUrl = `${(process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "")}/dashboard`;

  const text =
`Hi ${firstName(userName)},

${opening}${registeredLine}

${lines}

  Subtotal: ₹${(total / 1.18).toFixed(2)}
  GST (18%): ₹${(total - total / 1.18).toFixed(2)}
  Total: ₹${total.toFixed(2)} ${orderData.currency} (GST included)

  Purchase order: ${orderData.purchaseOrderNumber}
  Order ID: ${orderData.orderId}
  Invoice number: ${inv}
  Payment ID: ${orderData.paymentId}
  Order date: ${formatIndianDateTime(orderData.createdAt)}

See your domains and order in your dashboard:
  ${dashboardUrl}

${helpLines()}`;

  return send(userEmail, subject, text);
}

export async function sendAdminNotification(
  adminEmail: string,
  subject: string,
  message: string,
  data?: unknown
): Promise<boolean> {
  const html = `
    <div style="font-family: 'Google Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1A73E8;">Admin Notification</h2>
      <p>${message}</p>
      ${
        data
          ? `<pre style="background-color: #f3f4f6; padding: 15px; border-radius: 6px; overflow-x: auto;">${JSON.stringify(data, null, 2)}</pre>`
          : ""
      }
      <p>Please check your admin panel for more details.</p>
      <br>
      <p>Anutech Digital Private Limited</p>
    </div>
  `;
  return sendEmail({ to: adminEmail, subject: `[Admin] ${subject}`, html });
}

export async function sendLowBalanceAlert(
  adminEmail: string,
  balanceData: {
    availableBalance: string;
    threshold: number;
    resellerName?: string;
    resellerId?: string;
    unutilisedSellingBalance?: string;
    lockedBalance?: string;
  }
): Promise<boolean> {
  const balance = parseFloat(balanceData.availableBalance);
  const threshold = balanceData.threshold;
  const isCritical = balance < threshold * 0.5;

  const html = `
    <div style="font-family: 'Google Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, ${isCritical ? "#EA4335" : "#F59E0B"}, ${isCritical ? "#C5221F" : "#D97706"}); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: bold;">⚠️ Low Wallet Balance Alert</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9; font-size: 16px;">${isCritical ? "Critical Balance Warning" : "Balance Below Threshold"}</p>
      </div>

      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello Admin,</p>
        <p style="font-size: 16px; color: #374151; margin-bottom: 30px;">
          Your ResellerClub wallet balance has dropped below the configured threshold.
        </p>

        <div style="background-color: ${isCritical ? "#FEF2F2" : "#FFFBEB"}; border: 1px solid ${isCritical ? "#FECACA" : "#FCD34D"}; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
          <h3 style="color: ${isCritical ? "#DC2626" : "#92400E"}; margin: 0 0 15px 0; font-size: 18px;">💰 Wallet Balance Details</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; width: 200px;">Available Balance:</td>
              <td style="padding: 8px 0; font-weight: 700; color: ${isCritical ? "#DC2626" : "#92400E"}; font-size: 18px;">₹${balance.toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Threshold:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">₹${threshold.toFixed(2)}</td>
            </tr>
            ${
              balanceData.unutilisedSellingBalance
                ? `
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Unutilised Selling Balance:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">₹${parseFloat(balanceData.unutilisedSellingBalance).toFixed(2)}</td>
            </tr>
            `
                : ""
            }
            ${
              balanceData.lockedBalance
                ? `
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Locked Balance:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">₹${parseFloat(balanceData.lockedBalance).toFixed(2)}</td>
            </tr>
            `
                : ""
            }
            ${
              balanceData.resellerName
                ? `
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Reseller Name:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${balanceData.resellerName}</td>
            </tr>
            `
                : ""
            }
            ${
              balanceData.resellerId
                ? `
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Reseller ID:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${balanceData.resellerId}</td>
            </tr>
            `
                : ""
            }
          </table>
        </div>

        <div style="background-color: ${isCritical ? "#FEF2F2" : "#FFFBEB"}; border: 1px solid ${isCritical ? "#EF4444" : "#F59E0B"}; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
          <h4 style="color: ${isCritical ? "#DC2626" : "#92400E"}; margin: 0 0 10px 0; font-size: 16px;">⚠️ ${isCritical ? "CRITICAL" : "Warning"}</h4>
          <p style="color: ${isCritical ? "#991B1B" : "#78350F"}; margin: 0; font-size: 14px;">
            ${isCritical ? "Your wallet balance is critically low. Please top up your ResellerClub account immediately to avoid service interruptions." : "Your wallet balance is below the configured threshold. Consider topping up your ResellerClub account soon."}
          </p>
        </div>

        <div style="background-color: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
          <h4 style="color: #1E40AF; margin: 0 0 10px 0; font-size: 16px;">📋 Action Required</h4>
          <ul style="color: #1E3A8A; margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.6;">
            <li>Log in to your ResellerClub control panel</li>
            <li>Navigate to the Wallet/Balance section</li>
            <li>Add funds to your account to ensure uninterrupted service</li>
            <li>Monitor your balance regularly</li>
          </ul>
        </div>

        <div style="text-align: center; padding: 20px; border-top: 1px solid #e5e7eb; margin-top: 30px;">
          <p style="color: #6b7280; font-size: 14px; margin: 0 0 10px 0;">Need help? Contact our support team</p>
          <p style="margin: 0;">
            <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8; text-decoration: none; font-weight: 600;">
              ${SUPPORT_EMAIL}
            </a>
          </p>
        </div>
      </div>

      <div style="background-color: #f8fafc; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="color: #6b7280; font-size: 12px; margin: 0;">
          © ${new Date().getFullYear()} Anutech Digital Private Limited. All rights reserved.
        </p>
        <p style="color: #9ca3af; font-size: 11px; margin: 5px 0 0 0;">
          This is an automated alert. This email was sent because your wallet balance dropped below the configured threshold.
        </p>
      </div>
    </div>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `[${isCritical ? "CRITICAL" : "Warning"}] Low ResellerClub Wallet Balance - ₹${balance.toFixed(2)}`,
    html,
  });
}
