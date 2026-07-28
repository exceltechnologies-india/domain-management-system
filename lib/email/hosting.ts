import { sendEmail, SUPPORT_EMAIL } from "./transporter";

export async function sendHostingProvisionedEmail(
  userEmail: string,
  userName: string,
  hostingDetails: {
    domainName: string;
    packageName: string;
    planName?: string;
    serverIp: string;
    nameservers: string[];
    // Tokens-flow customers face a strict 1-attempt recurring-charge
    // policy (d4b6a64). They get an extra callout in the welcome email
    // setting that expectation up front. Subscriptions-flow + manual
    // customers default to undefined here → no callout.
    mandateMode?: "tokens" | "subscriptions" | "manual";
    // Trial signals — added 2026-07-03 so trials receive trial-specific
    // messaging (subject + header + banner + day-15 explanation) rather
    // than the generic "provisioned" copy. isTrial gate + optional
    // trialEndsAt used to compute the exact expiry date shown in the
    // email. Callers that don't pass isTrial fall through to the
    // unchanged paid-account flow.
    isTrial?: boolean;
    trialEndsAt?: Date | string | null;
  }
): Promise<boolean> {
  const isTrial = hostingDetails.isTrial === true;
  const trialEnds = isTrial && hostingDetails.trialEndsAt
    ? new Date(hostingDetails.trialEndsAt)
    : null;
  const trialEndsLabel = trialEnds && !isNaN(trialEnds.getTime())
    ? trialEnds.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;
  const planLabel = hostingDetails.planName || hostingDetails.packageName;

  const subject = isTrial
    ? `Your 15-Day Free Trial is Active — ${hostingDetails.domainName}`
    : "Hosting Account Provisioned Successfully";
  const nameserversList = hostingDetails.nameservers
    .map((ns) => `<li>${ns}</li>`)
    .join("");

  // Trial-specific banner. Replaces the generic "Service Activated" green
  // box when isTrial=true. Copy sets the expectation that no charge happens
  // today + gives the customer a direct link back to convert. The detailed
  // "what happens at day 15" billing explainer was removed per operator
  // request (2026-07-27) — kept the celebratory activation message only; the
  // day-15 reminder email (2 days before expiry) carries the conversion +
  // suspension details when they're actually relevant.
  const trialBanner = isTrial
    ? `
        <div style="background-color: #FEF3C7; border: 1px solid #F59E0B; border-radius: 8px; padding: 24px; margin: 20px 0;">
          <h3 style="color: #92400E; margin: 0 0 12px 0; font-size: 18px;">🎉 Your 15-Day Free Trial is Active</h3>
          <p style="color: #78350F; margin: 0; font-size: 14px; line-height: 1.6;">
            Your <strong>${planLabel}</strong> hosting for <strong>${hostingDetails.domainName}</strong> is now live${trialEndsLabel ? ` — free until <strong>${trialEndsLabel}</strong>` : ""}.
            Explore every feature: upload your site, create email accounts, install WordPress, set up databases — no charges today.
          </p>
        </div>
      `
    : `
        <div style="background-color: #D1FAE5; border: 1px solid #10B981; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #065F46; margin: 0 0 10px 0; font-size: 18px;">✅ Service Activated</h3>
          <p style="color: #065F46; margin: 0; font-size: 14px;">
            Your web hosting for <strong>${hostingDetails.domainName}</strong> has been successfully provisioned and is ready to use.
          </p>
        </div>
      `;

  // Tokens-flow-specific payment-method-validity callout. Shown only on the
  // NON-trial (paid) activation email, where an auto-renewal charge is
  // imminent. Deliberately NOT shown on the "Your Free Trial is Live" email:
  // the trial banner above already explains the day-15 billing + suspension
  // policy, nothing has been charged yet, and a second scary "keep your card
  // valid or you'll be suspended" box reads as alarming on a ₹0 free trial
  // (operator request 2026-07-27).
  const tokensFlowCallout =
    hostingDetails.mandateMode === "tokens" && !isTrial
      ? `
        <div style="background-color: #FEF3C7; border: 1px solid #F59E0B; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #92400E; margin: 0 0 10px 0; font-size: 16px;">⚠️ Important: Keep Your Payment Method Valid</h3>
          <p style="color: #78350F; margin: 0 0 8px 0; font-size: 14px;">
            Your hosting renews automatically. We will charge your saved payment method once when your billing cycle is due.
          </p>
          <p style="color: #78350F; margin: 0; font-size: 14px;">
            <strong>If that single charge fails</strong> (declined card, insufficient balance, revoked mandate), your service will be suspended and you'll need to re-subscribe with a new payment method to restore it. Please ensure the card or UPI ID on file stays valid — especially when it's close to expiry or you've recently changed banks.
          </p>
        </div>
      `
      : "";

  const headerTitle = isTrial ? "Your Free Trial is Live!" : "Hosting Account Active";
  const headerGradient = isTrial
    ? "linear-gradient(135deg, #F59E0B, #D97706)"
    : "linear-gradient(135deg, #1A73E8, #1557B0)";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: ${headerGradient}; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: bold;">${headerTitle}</h1>
      </div>

      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello ${userName},</p>

        ${trialBanner}

        ${tokensFlowCallout}

        <div style="background-color: #f3f4f6; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #1f2937; margin: 0 0 15px 0; font-size: 16px;">Account Details</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; width: 140px;">Domain:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${hostingDetails.domainName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Package:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${hostingDetails.planName || hostingDetails.packageName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Server IP:</td>
              <td style="padding: 8px 0; font-weight: 600; color: #1f2937;">${hostingDetails.serverIp}</td>
            </tr>
          </table>
        </div>

        <h3 style="color: #1f2937; margin: 25px 0 15px 0; font-size: 18px;">How to Manage Your Hosting</h3>

        <div style="margin-bottom: 20px;">
          <p style="font-size: 14px; color: #374151; margin-bottom: 10px;"><strong>1. Access Control Panel</strong></p>
          <p style="font-size: 14px; color: #6b7280; margin-bottom: 0;">
            You can log in to your hosting control panel directly from your dashboard without needing separate credentials.
          </p>
        </div>

        <div style="text-align: center; margin: 20px 0;">
          <a href="${process.env.NEXTAUTH_URL}/dashboard/hosting" style="display: inline-block; background: ${headerGradient}; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px;">${isTrial ? "Start Using Your Trial" : "Go to Hosting Dashboard"}</a>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="font-size: 14px; color: #374151; margin-bottom: 10px;"><strong>2. Update Nameservers</strong></p>
          <p style="font-size: 14px; color: #6b7280; margin-bottom: 10px;">
            If you purchased your domain from us, these nameservers are automatically configured. If your domain is with another registrar, update your nameservers to:
          </p>
          <ul style="background-color: #f8fafc; padding: 15px 15px 15px 35px; border-radius: 6px; color: #4b5563; font-family: monospace; font-size: 13px;">
            ${nameserversList}
          </ul>
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

/**
 * Confirmation that a customer cancelled their free trial. Sent (best-effort)
 * from POST /api/user/hosting/cancel-trial after the hosting is terminated,
 * the DA user suspended, and (Tokens-flow) the mandate token revoked. This is
 * a service/transactional email (account state change), not marketing.
 */
export async function sendHostingTrialCancelledEmail(
  userEmail: string,
  userName: string,
  details: { domainName: string }
): Promise<boolean> {
  const subject = `Your free trial has been cancelled — ${details.domainName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #6b7280, #4b5563); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 22px; font-weight: bold;">Free Trial Cancelled</h1>
      </div>

      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello ${userName},</p>

        <p style="font-size: 14px; color: #374151; line-height: 1.6; margin: 0 0 16px 0;">
          Your 15-day free trial for <strong>${details.domainName}</strong> has been cancelled and the hosting has been terminated. <strong>You have not been charged</strong>, and no future payment will be taken — your saved payment mandate has been cancelled.
        </p>

        <div style="background-color: #f3f4f6; border-radius: 8px; padding: 16px 20px; margin: 20px 0;">
          <p style="color: #4b5563; margin: 0; font-size: 14px; line-height: 1.6;">
            <strong>What this means:</strong> the hosting account is now suspended and won't renew. If you signed up a website, its files are no longer served. Nothing further is required from you.
          </p>
        </div>

        <p style="font-size: 14px; color: #6b7280; line-height: 1.6; margin: 16px 0 0 0;">
          Changed your mind or cancelled by accident? Reach out to us at
          <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a> and we'll help you get set up again.
        </p>
      </div>

      <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0; font-size: 14px; color: #6b7280;">
          Best regards,<br>
          <strong>Anutech Digital Private Limited Team</strong>
        </p>
        <p style="color: #9ca3af; margin: 8px 0 0 0; font-size: 11px;">© ${new Date().getFullYear()} Anutech Digital Private Limited. All rights reserved.</p>
      </div>
    </div>
  `;
  return sendEmail({ to: userEmail, subject, html });
}
