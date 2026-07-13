import { sendEmail, SUPPORT_EMAIL } from "./transporter";
import { sendNotificationEmail } from "./notifications";
import { formatIndianDate } from "../dateUtils";

export async function sendDomainPurchaseEmail(
  userEmail: string,
  userName: string,
  domains: Array<{ domainName: string; price: number; status: string }>,
  totalAmount: number
): Promise<boolean> {
  const subject = "Domain Purchase Confirmation";
  const domainList = domains
    .map(
      (domain) =>
        `<li>${domain.domainName} - ₹${domain.price} (${domain.status})</li>`
    )
    .join("");

  const html = `
    <div style="font-family: 'Google Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1A73E8;">Domain Purchase Confirmation</h2>
      <p>Hello ${userName},</p>
      <p>Your domain purchase has been processed successfully!</p>
      <h3>Purchase Details:</h3>
      <ul>
        ${domainList}
      </ul>
      <p><strong>Total Amount: ₹${totalAmount}</strong></p>
      <p>You can manage your domains from your <a href="${process.env.NEXTAUTH_URL}/dashboard" style="color: #1A73E8;">dashboard</a>.</p>
      <p>Thank you for choosing our service!</p>
      <p>If you have any questions, please contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.</p>
      <br>
      <p>Best regards,<br>Anutech Digital Private Limited Team</p>
    </div>
  `;
  return sendEmail({ to: userEmail, subject, html });
}

export async function sendDomainRegistrationEmail(
  userEmail: string,
  userName: string,
  domains: Array<{ domainName: string; expiresAt: Date }>
): Promise<boolean> {
  const subject = "Domain Registration Successful";
  const domainList = domains
    .map(
      (domain) =>
        `<li>${domain.domainName} - Expires: ${formatIndianDate(domain.expiresAt)}</li>`
    )
    .join("");

  const html = `
    <div style="font-family: 'Google Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #34A853;">Domain Registration Successful!</h2>
      <p>Hello ${userName},</p>
      <p>Great news! Your domains have been successfully registered:</p>
      <ul>
        ${domainList}
      </ul>
      <p>You can now manage your DNS records and domain settings from your <a href="${process.env.NEXTAUTH_URL}/dashboard/dns-management" style="color: #1A73E8;">DNS management panel</a>.</p>
      <p>If you need any assistance with your domains, please contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.</p>
      <br>
      <p>Best regards,<br>Anutech Digital Private Limited Team</p>
    </div>
  `;
  return sendEmail({ to: userEmail, subject, html });
}

export async function sendDomainRegistrationFailureEmail(
  userEmail: string,
  userName: string,
  domains: Array<{ domainName: string; error: string }>
): Promise<boolean> {
  const subject = "Domain Registration Issue";
  const domainList = domains
    .map((domain) => `<li>${domain.domainName} - Error: ${domain.error}</li>`)
    .join("");

  const html = `
    <div style="font-family: 'Google Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #EA4335;">Domain Registration Issue</h2>
      <p>Hello ${userName},</p>
      <p>We encountered some issues while registering your domains:</p>
      <ul>
        ${domainList}
      </ul>
      <p>Our team has been notified and will investigate the issue. You will receive a refund for any failed registrations.</p>
      <p>If you have any questions, please contact our support team immediately at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.</p>
      <br>
      <p>Best regards,<br>Anutech Digital Private Limited Team</p>
    </div>
  `;
  return sendEmail({ to: userEmail, subject, html });
}

export async function sendRenewalInvoiceEmail(
  userEmail: string,
  userName: string,
  invoiceDetails: {
    domainName: string;
    invoiceAmount: number;
    invoiceNumber?: string;
    dueDate: Date;
    renewalOrderId?: string;
    renewalPeriod?: number;
    periodUnit?: string;
  }
): Promise<boolean> {
  const subject = `Hosting Renewal Reminder - ${invoiceDetails.domainName}`;
  const payLink = process.env.NEXTAUTH_URL
    ? `${process.env.NEXTAUTH_URL}/dashboard/invoices`
    : "#";
  const periodDisplay =
    invoiceDetails.renewalPeriod && invoiceDetails.periodUnit
      ? `${invoiceDetails.renewalPeriod} ${invoiceDetails.periodUnit}${invoiceDetails.renewalPeriod > 1 ? "s" : ""}`
      : "1 Month";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #F59E0B, #D97706); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: bold;">Service Suspended – Renewal Required</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">Action Required: Pay to Reactivate</p>
      </div>

      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello ${userName},</p>

        <div style="background-color: #FEF3C7; border: 1px solid #F59E0B; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #92400E; margin: 0 0 10px 0; font-size: 18px;">⚠️ Service Suspended</h3>
          <p style="color: #92400E; margin: 0; font-size: 14px;">
            Your hosting service for <strong>${invoiceDetails.domainName}</strong> has expired and has been temporarily suspended.
          </p>
        </div>

        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">
          To reactivate your service instantly, please pay the renewal invoice below.
        </p>

        <div style="background-color: #f3f4f6; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #1f2937; margin: 0 0 15px 0; font-size: 16px;">Renewal Details</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; width: 140px;">Domain:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${invoiceDetails.domainName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Renewal Period:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${periodDisplay}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Amount Due:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">₹${invoiceDetails.invoiceAmount.toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Due Date:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${formatIndianDate(invoiceDetails.dueDate)}</td>
            </tr>
            ${
              invoiceDetails.invoiceNumber
                ? `
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Invoice Number:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${invoiceDetails.invoiceNumber}</td>
            </tr>
            `
                : ""
            }
          </table>
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${payLink}" style="display: inline-block; background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(26, 115, 232, 0.3);">Pay Now & Reactivate</a>
        </div>

        <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
          If you have any questions, please contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.
        </p>
      </div>

      <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0; font-size: 14px; color: #6b7280;">
          Best regards,<br>
          <strong>Anutech Digital Private Limited Team</strong>
        </p>
      </div>
    </div>
  `;
  return sendEmail({ to: userEmail, subject, html });
}

export async function sendDomainBookingStatusEmail(
  userEmail: string,
  userName: string,
  domains: Array<{
    domainName: string;
    status: string;
    registrationPeriod: number;
    expiresAt?: Date;
  }>,
  orderId?: string
): Promise<boolean> {
  const subject = "Domain Booking Status Notification";
  const orderStatusUrl = orderId
    ? `${process.env.NEXTAUTH_URL ?? ""}/dashboard/orders/${orderId}`
    : null;

  const activeDomains = domains.filter((d) => d.status === "registered");
  const pendingDomains = domains.filter(
    (d) => d.status === "pending" || d.status === "processing"
  );

  const activeList = activeDomains
    .map(
      (d) => `
    <div style="background-color: #f0fdf4; border-left: 4px solid #16a34a; padding: 12px; margin-bottom: 8px; border-radius: 4px;">
      <div style="font-weight: 600; color: #166534;">✅ ${d.domainName} (Active)</div>
      <div style="font-size: 12px; color: #15803d;">Registered for ${d.registrationPeriod} year${d.registrationPeriod !== 1 ? "s" : ""}${d.expiresAt ? ` - Expires: ${formatIndianDate(d.expiresAt)}` : ""}</div>
    </div>
  `
    )
    .join("");

  const pendingList = pendingDomains
    .map(
      (d) => `
    <div style="background-color: #fffbeb; border-left: 4px solid #d97706; padding: 12px; margin-bottom: 8px; border-radius: 4px;">
      <div style="font-weight: 600; color: #92400e;">⏳ ${d.domainName} (Processing)</div>
      <div style="font-size: 12px; color: #854d0e;">Our team is currently finalizing your registration. It will be active shortly.</div>
    </div>
  `
    )
    .join("");

  const html = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="background: linear-gradient(135deg, #1A73E8, #1557B0); color: white; padding: 30px; text-align: center;">
        <h1 style="margin: 0; font-size: 24px; font-weight: bold;">Domain Booking Received</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">We've started processing your registration</p>
      </div>

      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello ${userName},</p>
        <p style="font-size: 14px; color: #4b5563; margin-bottom: 25px;">
          Thank you for choosing Anutech Digital. We have received your domain booking request and the status of your domains is as follows:
        </p>

        ${
          activeList
            ? `
        <h3 style="color: #166534; font-size: 16px; margin-bottom: 12px;">Successfully Registered</h3>
        ${activeList}
        `
            : ""
        }

        ${
          pendingList
            ? `
        <h3 style="color: #92400e; font-size: 16px; margin-top: 25px; margin-bottom: 12px;">In Progress / Manual Review</h3>
        ${pendingList}
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 6px; margin-top: 15px;">
          <p style="font-size: 12px; color: #64748b; margin: 0;">
            <strong>Note:</strong> Technical verification is required for some domains. Our administrators are handling this manually to ensure successful registration. You will receive another confirmation once these are active.
          </p>
        </div>
        `
            : ""
        }

        <div style="margin-top: 35px; background-color: #f3f4f6; border-radius: 8px; padding: 25px; text-align: center;">
          <h4 style="margin: 0 0 10px 0; color: #1f2937; font-size: 16px;">Manage Your Domains</h4>
          <p style="font-size: 14px; color: #4b5563; margin-bottom: 20px;">
            You can track status, manage DNS, and view details in your dashboard.
          </p>
          ${orderStatusUrl ? `<a href="${orderStatusUrl}" style="display: inline-block; background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 6px rgba(26, 115, 232, 0.2); margin-bottom: 12px;">Track Order Status</a><br>` : ""}
          <a href="${process.env.NEXTAUTH_URL}/dashboard/domains" style="display: inline-block; ${orderStatusUrl ? "background: transparent; color: #1A73E8; border: 1px solid #1A73E8;" : "background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff;"} padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 14px;">Go to My Domains</a>
        </div>

        <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
          If you have any questions, please contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8; text-decoration: none;">${SUPPORT_EMAIL}</a>.
        </p>
      </div>

      <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0; font-size: 14px; color: #6b7280; font-weight: 600;">Best regards,</p>
        <p style="margin: 5px 0 0 0; font-size: 14px; color: #6b7280;">Anutech Digital Private Limited Team</p>
        <p style="margin: 15px 0 0 0; font-size: 11px; color: #9ca3af;">© ${new Date().getFullYear()} Anutech Digital Private Limited. All rights reserved.</p>
        <p style="margin: 5px 0 0 0; font-size: 11px; color: #9ca3af; font-weight: 600;">GSTIN: 07ABDCA0298H1ZP</p>
      </div>
    </div>
  `;
  return sendEmail({ to: userEmail, subject, html });
}

export async function sendServiceReminderEmail(
  userEmail: string,
  details: {
    serviceName: string;
    serviceType: string;
    daysRemaining: number;
    amount: number;
    currency: string;
    userName?: string;
  }
): Promise<boolean> {
  const isUrgent = details.daysRemaining <= 1;
  const isWarning = details.daysRemaining <= 7;
  const headerBg = isUrgent
    ? "linear-gradient(135deg, #DC2626, #991B1B)"
    : isWarning
    ? "linear-gradient(135deg, #F59E0B, #D97706)"
    : "linear-gradient(135deg, #1A73E8, #1557B0)";
  const badgeBg = isUrgent ? "#FEE2E2" : isWarning ? "#FEF3C7" : "#DBEAFE";
  const badgeBorder = isUrgent ? "#DC2626" : isWarning ? "#F59E0B" : "#3B82F6";
  const badgeText = isUrgent ? "#991B1B" : isWarning ? "#92400E" : "#1E40AF";
  const urgencyIcon = isUrgent ? "🚨" : isWarning ? "⚠️" : "📅";
  const urgencyLabel = isUrgent
    ? "EXPIRES TODAY — Action Required Immediately"
    : isWarning
    ? `Expires in ${details.daysRemaining} days — Action Required`
    : `Expires in ${details.daysRemaining} days — Renewal Reminder`;

  const dashboardPath = details.serviceType === "hosting" ? "/dashboard/hosting" : "/dashboard/domains";
  const renewUrl = `${process.env.NEXTAUTH_URL || ""}${dashboardPath}`;
  const greeting = details.userName ? `Hello ${details.userName},` : "Hello,";
  const amountDisplay = details.amount > 0
    ? `<tr>
        <td style="padding: 8px 0; color: #6b7280; width: 140px;">Renewal Amount:</td>
        <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">₹${details.amount.toLocaleString()} ${details.currency}</td>
      </tr>`
    : "";

  const subject = isUrgent
    ? `🚨 URGENT: Your ${details.serviceType} ${details.serviceName} expires TODAY`
    : `Renewal Reminder: ${details.serviceName} expires in ${details.daysRemaining} day${details.daysRemaining !== 1 ? "s" : ""}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: ${headerBg}; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: bold;">${urgencyIcon} Service Renewal Reminder</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">${urgencyLabel}</p>
      </div>

      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">${greeting}</p>

        <div style="background-color: ${badgeBg}; border: 1px solid ${badgeBorder}; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: ${badgeText}; margin: 0 0 10px 0; font-size: 18px;">${urgencyIcon} ${urgencyLabel}</h3>
          <p style="color: ${badgeText}; margin: 0; font-size: 14px;">
            Your <strong>${details.serviceType}</strong> <strong>${details.serviceName}</strong> will expire in <strong>${details.daysRemaining} day${details.daysRemaining !== 1 ? "s" : ""}</strong>.
            Renew now to avoid service interruption.
          </p>
        </div>

        <div style="background-color: #f3f4f6; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #1f2937; margin: 0 0 15px 0; font-size: 16px;">Service Details</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; width: 140px;">Service:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${details.serviceName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Type:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937; text-transform: capitalize;">${details.serviceType}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Days Remaining:</td>
              <td style="padding: 8px 0; font-weight: 600; color: ${isUrgent ? "#DC2626" : "#1f2937"};">${details.daysRemaining} day${details.daysRemaining !== 1 ? "s" : ""}</td>
            </tr>
            ${amountDisplay}
          </table>
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${renewUrl}" style="display: inline-block; background: ${headerBg}; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(0,0,0,0.15);">Renew Now</a>
        </div>

        <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
          If you have any questions, please contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.
        </p>
      </div>

      <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0; font-size: 14px; color: #6b7280;">
          Best regards,<br>
          <strong>Anutech Digital Private Limited Team</strong>
        </p>
      </div>
    </div>
  `;
  return sendNotificationEmail({ to: userEmail, subject, html });
}

export async function sendServiceExpiryTodayEmail(
  userEmail: string,
  details: { serviceName: string; serviceType: string; userName?: string }
): Promise<boolean> {
  const dashboardPath = details.serviceType === "hosting" ? "/dashboard/hosting" : "/dashboard/domains";
  const renewUrl = `${process.env.NEXTAUTH_URL || ""}${dashboardPath}`;
  const greeting = details.userName ? `Hello ${details.userName},` : "Hello,";
  const subject = `🚨 URGENT: Your ${details.serviceType} ${details.serviceName} expires TODAY`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #DC2626, #991B1B); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: bold;">🚨 Service Expires TODAY</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">Immediate Action Required — Renew to Prevent Suspension</p>
      </div>

      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">${greeting}</p>

        <div style="background-color: #FEE2E2; border: 1px solid #DC2626; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #991B1B; margin: 0 0 10px 0; font-size: 18px;">🚨 Final Warning</h3>
          <p style="color: #991B1B; margin: 0; font-size: 14px;">
            Your <strong>${details.serviceType}</strong> <strong>${details.serviceName}</strong> expires today.
            If not renewed, your service will be automatically suspended.
          </p>
        </div>

        <p style="font-size: 15px; color: #374151; margin: 20px 0;">
          To keep your service running without interruption, please renew immediately from your dashboard.
        </p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${renewUrl}" style="display: inline-block; background: linear-gradient(135deg, #DC2626, #991B1B); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(220,38,38,0.3);">Renew Now — Prevent Suspension</a>
        </div>

        <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
          If you have any questions, please contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.
        </p>
      </div>

      <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0; font-size: 14px; color: #6b7280;">
          Best regards,<br>
          <strong>Anutech Digital Private Limited Team</strong>
        </p>
      </div>
    </div>
  `;
  return sendNotificationEmail({ to: userEmail, subject, html });
}

export async function sendServiceSuspensionEmail(
  userEmail: string,
  details: {
    serviceName: string;
    serviceType: string;
    // Tokens-flow customers see a different recovery path because the
    // hard 1-attempt MIT policy (d4b6a64) means the mandate is dead
    // after a single failure — they MUST re-subscribe via a new CIT
    // auth + new mandate. Subscriptions-flow customers (whose retries
    // are managed by Razorpay server-side, several attempts before
    // halting) may be able to update payment in their existing
    // subscription. Manual customers don't have auto-renewal at all.
    // Defaults to undefined → generic wording for back-compat.
    mandateMode?: "tokens" | "subscriptions" | "manual";
  }
): Promise<boolean> {
  const subject = `Account Suspended: ${details.serviceName}`;
  const dashboardUrl = `${process.env.NEXTAUTH_URL || ""}/dashboard/hosting`;
  const supportEmail = process.env.SUPPORT_EMAIL || "support@example.com";

  // Recovery-path copy varies by mandate mode. Tokens-flow gets a
  // specific re-subscribe CTA because their mandate is dead; the
  // others get the generic contact-support fallback.
  const recoveryBlock =
    details.mandateMode === "tokens"
      ? `
        <div style="background-color: #FEF3C7; border: 1px solid #F59E0B; border-radius: 8px; padding: 18px; margin: 20px 0;">
          <h3 style="color: #92400E; margin: 0 0 10px 0; font-size: 16px;">What happened</h3>
          <p style="color: #78350F; margin: 0 0 8px 0; font-size: 14px;">
            Your saved payment method couldn't be charged for the renewal of this ${details.serviceType}. Under our renewal policy each recurring charge is attempted once — if it fails, service is suspended immediately and the payment mandate is closed.
          </p>
          <p style="color: #78350F; margin: 0; font-size: 14px;">
            Common causes: card expired or replaced, insufficient balance at the moment of the charge, or a UPI mandate that was revoked in your bank app.
          </p>
        </div>
        <h3 style="color: #1f2937; margin: 25px 0 10px 0; font-size: 16px;">How to restore service</h3>
        <p style="color: #4b5563; font-size: 14px; margin: 0 0 12px 0;">
          Sign in to your dashboard, choose <strong>${details.serviceName}</strong>, and re-subscribe with a fresh card or UPI ID. A new mandate will be set up and your hosting will be reactivated as soon as the first charge succeeds.
        </p>
        <div style="text-align: center; margin: 25px 0;">
          <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px;">
            Restore Service
          </a>
        </div>`
      : `
        <p style="color: #4b5563; font-size: 14px; margin: 0 0 12px 0;">
          Please contact support to resolve this issue and restore service.
        </p>
        <div style="text-align: center; margin: 25px 0;">
          <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px;">
            Open Dashboard
          </a>
        </div>`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #DC2626, #991B1B); color: white; padding: 25px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 22px; font-weight: bold;">Service Suspended</h1>
        <p style="margin: 8px 0 0 0; opacity: 0.9;">${details.serviceName}</p>
      </div>

      <div style="padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 15px;">
          Your ${details.serviceType} <strong>${details.serviceName}</strong> has been suspended due to a failed renewal payment.
        </p>

        ${recoveryBlock}

        <p style="font-size: 13px; color: #6b7280; margin-top: 25px;">
          Need help? Reply to this email or contact us at
          <a href="mailto:${supportEmail}" style="color: #1A73E8;">${supportEmail}</a>.
        </p>
      </div>
    </div>
  `;
  return sendEmail({ to: userEmail, subject, html });
}

export async function sendServiceGracePeriodEmail(
  userEmail: string,
  details: {
    serviceName: string;
    serviceType: string;
    graceDays: number;
    graceEndsAt: Date;
  }
): Promise<boolean> {
  const graceEndFormatted = details.graceEndsAt.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const subject = `Grace Period Active: Renew ${details.serviceName} before ${graceEndFormatted}`;
  const dashboardUrl = `${process.env.NEXTAUTH_URL || ""}/dashboard`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #F59E0B, #D97706); color: white; padding: 25px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 22px; font-weight: bold;">⏳ Grace Period Active</h1>
        <p style="margin: 8px 0 0 0; opacity: 0.9;">Your service has expired but is still accessible</p>
      </div>

      <div style="padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello,</p>

        <div style="background-color: #FEF3C7; border: 1px solid #F59E0B; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
          <h3 style="color: #92400E; margin: 0 0 10px 0;">⚠️ Renewal Required</h3>
          <p style="color: #92400E; margin: 0; font-size: 14px;">
            Your <strong>${details.serviceType}</strong> <strong>${details.serviceName}</strong> has expired.
            It has entered a <strong>${details.graceDays}-day grace period</strong> and will be suspended on
            <strong>${graceEndFormatted}</strong> if not renewed.
          </p>
        </div>

        <p style="font-size: 14px; color: #4b5563; margin-bottom: 25px;">
          During the grace period your service remains accessible. Please renew immediately to avoid suspension.
        </p>

        <div style="text-align: center; margin: 25px 0;">
          <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px;">
            Renew Now
          </a>
        </div>

        <p style="font-size: 13px; color: #6b7280; margin-top: 25px;">
          Need help? Contact us at
          <a href="mailto:${process.env.SUPPORT_EMAIL || "support@example.com"}" style="color: #1A73E8;">
            ${process.env.SUPPORT_EMAIL || "support@example.com"}
          </a>
        </p>
      </div>
    </div>
  `;
  return sendNotificationEmail({ to: userEmail, subject, html });
}

export async function sendDomainAvailableEmail(
  userEmail: string,
  domainName: string,
  userName?: string
): Promise<boolean> {
  const searchUrl = `${process.env.NEXTAUTH_URL ?? ""}/domain-search?q=${encodeURIComponent(domainName)}`;
  const greeting = userName ? `Hello ${userName},` : "Hello,";
  const subject = `Good news! ${domainName} is now available`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #16A34A, #15803D); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: bold;">Domain Now Available!</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">A domain you were watching just became available</p>
      </div>
      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">${greeting}</p>
        <div style="background-color: #F0FDF4; border: 1px solid #16A34A; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #166534; margin: 0 0 10px 0; font-size: 18px;">Available to Register</h3>
          <p style="color: #166534; margin: 0; font-size: 14px;">
            <strong>${domainName}</strong> is now available for registration. Do not wait — popular domains get snapped up quickly!
          </p>
        </div>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${searchUrl}" style="display: inline-block; background: linear-gradient(135deg, #16A34A, #15803D); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(22,163,74,0.3);">Register ${domainName} Now</a>
        </div>
        <p style="font-size: 14px; color: #6b7280; margin-top: 20px;">
          You will receive no further notifications for this domain unless you add it to your watch list again.
        </p>
        <p style="font-size: 14px; color: #6b7280; margin-top: 10px;">
          If you have any questions, contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.
        </p>
      </div>
      <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0; font-size: 14px; color: #6b7280;">
          Best regards,<br>
          <strong>Anutech Digital Private Limited Team</strong>
        </p>
      </div>
    </div>
  `;
  return sendNotificationEmail({ to: userEmail, subject, html });
}
