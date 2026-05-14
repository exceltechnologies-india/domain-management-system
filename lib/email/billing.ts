import { sendEmail, SUPPORT_EMAIL } from "./transporter";
import { formatIndianDateTime } from "../dateUtils";

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
  let subject: string;
  let headerColor: string;
  let headerTitle: string;
  let statusMessage: string;

  if (orderData.registrationFailed && orderData.paymentStatus === "success") {
    subject = `Purchase Order - ${orderData.purchaseOrderNumber} (Registration Failed)`;
    headerColor = "#F59E0B";
    headerTitle = "Purchase Order - Registration Failed";
    statusMessage = `Your payment has been received successfully! However, domain registration failed due to technical reasons. Purchase Order ${orderData.purchaseOrderNumber} has been generated. A refund will be initiated within 2-10 business days.`;
  } else if (orderData.paymentStatus === "success") {
    subject = `Purchase Order - ${orderData.purchaseOrderNumber}`;
    headerColor = "#1A73E8";
    headerTitle = "Purchase Order";
    statusMessage = `Your payment has been received successfully! Purchase Order ${orderData.purchaseOrderNumber} has been generated. Your domain registration is being processed.`;
  } else {
    subject = `Purchase Order - ${orderData.purchaseOrderNumber} (Payment Failed)`;
    headerColor = "#EA4335";
    headerTitle = "Purchase Order - Payment Failed";
    statusMessage = `Your payment has failed. However, Purchase Order ${orderData.purchaseOrderNumber} has been generated. Please contact support to complete your payment.`;
  }

  const domainsList = orderData.domains
    .map((domain) => {
      let displayName = domain.domainName;
      if (domain.itemType === "hosting" || domain.planName) {
        displayName += ` <br><span style="font-size: 12px; color: #666;">(${domain.planName || "Hosting Plan"})</span>`;
      }
      return `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${displayName}</td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${domain.registrationPeriod} ${domain.periodUnit || "year"}${domain.registrationPeriod !== 1 ? "s" : ""}</td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">₹${domain.price.toFixed(2)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">₹${(domain.price * domain.registrationPeriod).toFixed(2)}</td>
      </tr>
    `;
    })
    .join("");

  const gstAmount = orderData.amount - orderData.subtotal;
  const gstPercent =
    orderData.subtotal > 0
      ? ((gstAmount / orderData.subtotal) * 100).toFixed(0)
      : "18";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, ${headerColor}, ${headerColor}dd); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 28px;">${headerTitle}</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">${orderData.paymentStatus === "success" ? "Thank you for your purchase!" : "Please contact support"}</p>
      </div>

      <div style="padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello ${userName},</p>
        <p style="font-size: 16px; color: #374151; margin-bottom: 30px;">${statusMessage}</p>

        <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
          <h3 style="color: #1f2937; margin: 0 0 15px 0;">Purchase Order Details</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; width: 180px;">Purchase Order Number:</td>
              <td style="padding: 8px 0; font-weight: 700; color: #1A73E8; font-size: 16px;">${orderData.purchaseOrderNumber}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Order ID:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${orderData.orderId}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Invoice Number:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${orderData.invoiceNumber}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Payment Status:</td>
              <td style="padding: 8px 0; font-weight: 600; color: ${orderData.paymentStatus === "success" ? "#34A853" : "#EA4335"};">
                ${orderData.paymentStatus === "success" ? "✅ Successful" : "❌ Failed"}
              </td>
            </tr>
            ${
              orderData.paymentStatus === "success"
                ? `
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Payment ID:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${orderData.paymentId}</td>
            </tr>
            `
                : ""
            }
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Date:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${formatIndianDateTime(orderData.createdAt)}</td>
            </tr>
          </table>
        </div>

        <div style="margin-bottom: 30px;">
          <h3 style="color: #1f2937; margin: 0 0 15px 0;">Domain Details</h3>
          <table style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb;">
            <thead>
              <tr style="background-color: #f8fafc;">
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb; color: #374151; font-weight: 600;">Domain Name</th>
                <th style="padding: 12px; text-align: center; border-bottom: 2px solid #e5e7eb; color: #374151; font-weight: 600;">Period</th>
                <th style="padding: 12px; text-align: right; border-bottom: 2px solid #e5e7eb; color: #374151; font-weight: 600;">Price/Year</th>
                <th style="padding: 12px; text-align: right; border-bottom: 2px solid #e5e7eb; color: #374151; font-weight: 600;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${domainsList}
            </tbody>
          </table>
        </div>

        <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
          <h3 style="color: #1f2937; margin: 0 0 15px 0;">Payment Summary</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Subtotal:</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 600; color: #1f2937;">₹${orderData.subtotal.toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">GST (${gstPercent}%):</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 600; color: #1f2937;">₹${gstAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-top: 2px solid #e5e7eb;">
              <td style="padding: 12px 0; font-weight: 700; color: #1f2937; font-size: 16px;">Total Amount:</td>
              <td style="padding: 12px 0; text-align: right; font-weight: 700; color: #1A73E8; font-size: 18px;">₹${orderData.amount.toFixed(2)} ${orderData.currency}</td>
            </tr>
          </table>
          <p style="font-size: 12px; color: #6b7280; margin-top: 10px; margin-bottom: 0;">*GST (${gstPercent}%) is included in the total amount</p>
        </div>

        ${
          orderData.paymentStatus === "failed"
            ? `
        <div style="background-color: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
          <h3 style="color: #DC2626; margin: 0 0 10px 0;">⚠️ Payment Failed</h3>
          <p style="color: #991B1B; margin: 0; font-size: 14px;">
            Your payment could not be processed. Please contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #DC2626; text-decoration: underline;">${SUPPORT_EMAIL}</a> to complete your payment and proceed with domain registration.
          </p>
        </div>
        `
            : ""
        }

        ${
          orderData.registrationFailed && orderData.paymentStatus === "success"
            ? `
        <div style="background-color: #FFFBEB; border: 1px solid #FCD34D; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
          <h3 style="color: #92400E; margin: 0 0 10px 0;">⚠️ Registration Failed</h3>
          <p style="color: #78350F; margin: 0 0 10px 0; font-size: 14px;">
            <strong>Payment Status:</strong> ✅ Your payment was successful.
          </p>
          <p style="color: #78350F; margin: 0 0 10px 0; font-size: 14px;">
            <strong>Registration Status:</strong> ❌ Domain registration failed due to technical reasons.
          </p>
          <p style="color: #78350F; margin: 0; font-size: 14px; font-weight: 600;">
            💰 <strong>Refund:</strong> A refund will be initiated within 2-10 business days to your original payment method.
          </p>
        </div>
        `
            : ""
        }

        <div style="background-color: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
          <h3 style="color: #1E40AF; margin: 0 0 10px 0;">📋 Next Steps</h3>
          <p style="color: #1E3A8A; margin: 0; font-size: 14px;">
            ${
              orderData.registrationFailed && orderData.paymentStatus === "success"
                ? `Your refund will be processed automatically within 2-10 business days. If you have any questions, please contact our support team at ${SUPPORT_EMAIL}.`
                : orderData.paymentStatus === "success"
                  ? "Your domain registration is being processed. You will receive a confirmation email once your domains are successfully registered."
                  : `Please contact our support team at ${SUPPORT_EMAIL} to resolve the payment issue and complete your order.`
            }
          </p>
        </div>

        <div style="text-align: center; padding: 20px; border-top: 1px solid #e5e7eb; margin-top: 30px;">
          <p style="color: #6b7280; font-size: 14px; margin: 0 0 10px 0;">
            Need help? Contact our support team
          </p>
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
      </div>
    </div>
  `;

  return sendEmail({ to: userEmail, subject, html });
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

  let subject: string;
  let statusMessage: string;
  let headerColor: string;
  let headerTitle: string;

  if (hasSuccessfulDomains && !hasPendingDomains) {
    subject = `Order Confirmation - ${orderData.invoiceNumber}`;
    statusMessage =
      "Your order has been processed successfully. All domains have been registered.";
    headerColor = "#34A853";
    headerTitle = "Order Confirmation";
  } else if (hasPendingDomains && hasOnlyPendingOrSuccessful) {
    subject = `Payment Successful - ${orderData.invoiceNumber}`;
    statusMessage =
      "Your payment has been received successfully! Your domain registration is being processed and will be completed shortly.";
    headerColor = "#1A73E8";
    headerTitle = "Payment Successful";
  } else if (hasSuccessfulDomains && hasPendingDomains) {
    subject = `Payment Successful - ${orderData.invoiceNumber}`;
    statusMessage =
      "Your payment has been received successfully! Some domains have been registered, while others are being processed.";
    headerColor = "#1A73E8";
    headerTitle = "Payment Successful";
  } else {
    subject = `Payment Received - ${orderData.invoiceNumber}`;
    statusMessage =
      "Your payment has been received. We encountered issues with domain registration. Our team will contact you shortly.";
    headerColor = "#F59E0B";
    headerTitle = "Payment Received";
  }

  const allDomainsList = orderData.allDomains
    .map((domain) => {
      let statusColor: string;
      let statusText: string;

      if (domain.status === "registered") {
        statusColor = "#34A853";
        statusText = "✅ Registered";
      } else if (domain.status === "pending") {
        statusColor = "#1A73E8";
        statusText = "🔄 Processing";
      } else {
        statusColor = "#EA4335";
        statusText = "⚠️ Contact Support";
      }

      return `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">
          ${domain.domainName}
          ${domain.planName ? `<br><span style="font-size: 12px; color: #666;">(${domain.planName})</span>` : ""}
          <br>
          <span style="font-size: 12px; color: ${statusColor}; font-weight: 600;">${statusText}</span>
        </td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${domain.registrationPeriod} year${domain.registrationPeriod !== 1 ? "s" : ""}</td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">1</td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">₹${domain.price.toFixed(2)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">₹${(domain.price * domain.registrationPeriod).toFixed(2)}</td>
      </tr>
    `;
    })
    .join("");

  const total = orderData.amount;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, ${headerColor}, ${headerColor}dd); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 28px;">${headerTitle}</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">${hasSuccessfulDomains || hasPendingDomains ? "Thank you for your purchase!" : "We apologize for the inconvenience."}</p>
      </div>

      <div style="padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello ${userName},</p>
        <p style="font-size: 16px; color: #374151; margin-bottom: 30px;">${statusMessage}</p>

        <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
          <h3 style="color: #1f2937; margin: 0 0 15px 0;">Order Information</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; width: 150px;">Purchase Order:</td>
              <td style="padding: 8px 0; font-weight: 700; color: #1A73E8; font-size: 15px;">${orderData.purchaseOrderNumber}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Order ID:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${orderData.orderId}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Invoice Number:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${orderData.invoiceNumber}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Payment ID:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${orderData.paymentId}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Order Date:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${formatIndianDateTime(orderData.createdAt)}</td>
            </tr>
          </table>
        </div>

        <div style="margin-bottom: 30px;">
          <h3 style="color: #1f2937; margin: 0 0 15px 0;">Domain Details</h3>
          <table style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
            <thead>
              <tr style="background-color: #f8fafc;">
                <th style="padding: 12px; text-align: left; font-weight: 600; color: #374151; border-bottom: 1px solid #e5e7eb;">Domain Name</th>
                <th style="padding: 12px; text-align: center; font-weight: 600; color: #374151; border-bottom: 1px solid #e5e7eb;">Period</th>
                <th style="padding: 12px; text-align: center; font-weight: 600; color: #374151; border-bottom: 1px solid #e5e7eb;">Qty</th>
                <th style="padding: 12px; text-align: right; font-weight: 600; color: #374151; border-bottom: 1px solid #e5e7eb;">Unit Price</th>
                <th style="padding: 12px; text-align: right; font-weight: 600; color: #374151; border-bottom: 1px solid #e5e7eb;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${allDomainsList}
            </tbody>
          </table>
        </div>

        <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
          <h3 style="color: #1f2937; margin: 0 0 15px 0;">Order Summary</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Subtotal:</td>
              <td style="padding: 8px 0; text-align: right; color: #1f2937; font-weight: 500;">₹${(total / 1.18).toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">GST (18%):</td>
              <td style="padding: 8px 0; text-align: right; color: #1f2937; font-weight: 500;">₹${(total - total / 1.18).toFixed(2)}</td>
            </tr>
            <tr style="border-top: 2px solid #e5e7eb;">
              <td style="padding: 12px 0; font-size: 18px; font-weight: 700; color: #1f2937;">Total (incl. GST):</td>
              <td style="padding: 12px 0; text-align: right; font-size: 18px; font-weight: 700; color: #1A73E8;">₹${total.toFixed(2)} ${orderData.currency}</td>
            </tr>
          </table>
          <p style="margin: 10px 0 0 0; color: #9ca3af; font-size: 12px; text-align: right;">*GST (18%) is included in the total amount</p>
        </div>

        ${
          orderData.successfulDomains.length > 0
            ? `
        <div style="background-color: #D1FAE5; border: 1px solid #34A853; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
          <p style="margin: 0; color: #065F46; font-weight: 600;">✅ ${orderData.successfulDomains.length} domain(s) registered successfully!</p>
        </div>
        `
            : ""
        }

        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.NEXTAUTH_URL}/dashboard" style="display: inline-block; background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(26, 115, 232, 0.3); margin: 0 10px;">View Dashboard</a>
          <a href="${process.env.NEXTAUTH_URL}/" style="background-color: #6b7280; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; display: inline-block; margin: 0 10px; font-weight: 600;">Visit Homepage</a>
        </div>

        <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; margin-top: 30px; text-align: center;">
          <p style="color: #6b7280; font-size: 14px; margin: 0 0 10px 0;">Need help? Contact our support team:</p>
          <p style="color: #6b7280; font-size: 14px; margin: 0;">Email: <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a></p>
        </div>
      </div>

      <div style="background-color: #f8fafc; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0; color: #6b7280; font-size: 14px;">Thank you for choosing Anutech Digital Private Limited!</p>
        <p style="margin: 5px 0 0 0; color: #6b7280; font-size: 12px;">This is an automated email. Please do not reply to this message.</p>
      </div>
    </div>
  `;

  return sendEmail({ to: userEmail, subject, html });
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
