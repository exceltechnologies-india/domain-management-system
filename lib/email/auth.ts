import { sendEmail, SUPPORT_EMAIL } from "./transporter";
import { sendNotificationEmail } from "./notifications";

export async function sendWelcomeEmail(
  userEmail: string,
  userName: string
): Promise<boolean> {
  const subject = "Welcome to Anutech Digital Private Limited Domain Management!";
  const html = `
    <div style="font-family: 'Google Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1A73E8;">Welcome to Anutech Digital Private Limited Domain Management!</h2>
      <p>Hello ${userName},</p>
      <p>Thank you for creating an account with us. You can now:</p>
      <ul>
        <li>Search for available domains</li>
        <li>Purchase domains securely</li>
        <li>Manage your DNS records</li>
        <li>Track your domain portfolio</li>
      </ul>
      <p>Get started by visiting your <a href="${process.env.NEXTAUTH_URL}/dashboard" style="color: #1A73E8;">dashboard</a>.</p>
      <p>If you have any questions, feel free to contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.</p>
      <br>
      <p>Best regards,<br>Anutech Digital Private Limited Team</p>
    </div>
  `;
  return sendEmail({ to: userEmail, subject, html });
}

export async function sendPasswordResetEmail(
  userEmail: string,
  userName: string,
  resetToken: string,
  /** When true, the email is framed as a first-time account setup
   * (guest → full account) rather than a recovery flow. */
  isSetup: boolean = false
): Promise<boolean> {
  const subject = isSetup ? "Set up your account password" : "Password Reset Request";
  const resetUrl = `${process.env.NEXTAUTH_URL}/reset-password?token=${resetToken}${isSetup ? "&setup=1" : ""}`;
  const headline = isSetup ? "🔑 Set Up Your Password" : "🔒 Password Reset Request";
  const intro = isSetup
    ? "Thanks for your recent purchase! To finish setting up your account, choose a password using the button below:"
    : "You requested to reset your password. Click the button below to reset it:";
  const buttonLabel = isSetup ? "Set Password" : "Reset Password";
  const warningText = isSetup
    ? "⚠️ This link will expire in 1 hour for security reasons. If you didn't sign up, you can safely ignore this email."
    : "⚠️ This link will expire in 1 hour for security reasons. If you didn't request this password reset, please ignore this email.";

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Google Sans', Arial, sans-serif; background-color: #f8f9fa;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
        <div style="background: linear-gradient(135deg, #1A73E8, #1557B0); padding: 30px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">${headline}</h1>
        </div>
        <div style="padding: 30px;">
          <p style="font-size: 16px; color: #374151;">Hello ${userName},</p>
          <p style="font-size: 16px; color: #374151;">${intro}</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(26, 115, 232, 0.3);">${buttonLabel}</a>
          </div>
          <div style="background-color: #f9fafb; border-radius: 6px; padding: 15px; margin-bottom: 25px;">
            <p style="color: #6b7280; margin: 0 0 10px 0; font-size: 14px; font-weight: bold;">Can't click the button?</p>
            <p style="color: #6b7280; margin: 0; font-size: 14px; word-break: break-all;">
              Copy and paste this link into your browser:<br>
              <span style="color: #1A73E8;">${resetUrl}</span>
            </p>
          </div>
          <div style="background-color: #FEF3C7; border: 1px solid #F59E0B; border-radius: 8px; padding: 15px;">
            <p style="color: #92400E; margin: 0; font-size: 14px;">
              ${warningText}
            </p>
          </div>
        </div>
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; margin: 0; font-size: 14px;">Best regards,<br>Anutech Digital Private Limited Team</p>
          <p style="color: #9ca3af; margin: 5px 0 0 0; font-size: 12px;">© 2024 Anutech Digital Private Limited. All rights reserved.</p>
          <p style="color: #9ca3af; margin: 5px 0 0 0; font-size: 11px; font-weight: 600;">GSTIN: 07ABDCA0298H1ZP</p>
        </div>
      </div>
    </body>
    </html>
  `;
  return sendEmail({ to: userEmail, subject, html });
}

export async function sendPasswordResetNotificationEmail(
  userEmail: string,
  userName: string,
  newPassword: string
): Promise<boolean> {
  const subject = "Your Password Has Been Reset";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #1A73E8, #1557B0); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: bold;">Password Reset Notification</h1>
      </div>

      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello ${userName},</p>

        <div style="background-color: #FEF3C7; border: 1px solid #F59E0B; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #92400E; margin: 0 0 10px 0; font-size: 18px;">🔐 Password Reset by Administrator</h3>
          <p style="color: #92400E; margin: 0; font-size: 14px;">Your password has been reset by an administrator. Please use the new password below to log in.</p>
        </div>

        <div style="background-color: #f3f4f6; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h4 style="color: #374151; margin: 0 0 10px 0; font-size: 16px;">Your New Password:</h4>
          <div style="background-color: #ffffff; border: 2px solid #1A73E8; border-radius: 6px; padding: 15px; font-family: 'Courier New', monospace; font-size: 18px; font-weight: bold; color: #1f2937; text-align: center; letter-spacing: 1px;">
            ${newPassword}
          </div>
        </div>

        <div style="background-color: #FEF2F2; border: 1px solid #EF4444; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h4 style="color: #DC2626; margin: 0 0 10px 0; font-size: 16px;">⚠️ Important Security Notice</h4>
          <ul style="color: #DC2626; margin: 0; padding-left: 20px; font-size: 14px;">
            <li>Please log in immediately and change your password to something secure</li>
            <li>Do not share this password with anyone</li>
            <li>Consider using a password manager for better security</li>
          </ul>
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.NEXTAUTH_URL}/login" style="display: inline-block; background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(26, 115, 232, 0.3);">Log In Now</a>
        </div>

        <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
          If you have any questions or concerns, please contact our support team immediately at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.
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

export async function sendPasswordChangeNotificationEmail(
  userEmail: string,
  userName: string,
  isFirstTimeSet: boolean = false,
  provider?: string
): Promise<boolean> {
  const subject = isFirstTimeSet
    ? "Password Set Successfully"
    : "Password Changed Successfully";

  const actionText = isFirstTimeSet ? "set" : "changed";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #1A73E8, #1557B0); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: bold;">${isFirstTimeSet ? 'Password Set Successfully' : 'Password Changed Successfully'}</h1>
      </div>

      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello ${userName},</p>

        <div style="background-color: #D1FAE5; border: 1px solid #10B981; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #065F46; margin: 0 0 10px 0; font-size: 18px;">✅ Password ${actionText.charAt(0).toUpperCase() + actionText.slice(1)}</h3>
          <p style="color: #065F46; margin: 0; font-size: 14px;">
            Your password has been ${actionText} successfully. You can now use your email and password to log in to your account.
          </p>
        </div>

        ${isFirstTimeSet ? `
        <div style="background-color: #EFF6FF; border: 1px solid #3B82F6; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h4 style="color: #1E40AF; margin: 0 0 10px 0; font-size: 16px;">🔐 Login Options</h4>
          <p style="color: #1E3A8A; margin: 0; font-size: 14px;">
            You can now log in using either:
          </p>
          <ul style="color: #1E3A8A; margin: 10px 0 0 0; padding-left: 20px; font-size: 14px;">
            <li>Your email and password (newly set)</li>
            <li>Your social login account${provider && provider !== 'credentials' ? ` (${provider === 'google' ? 'Google' : provider.charAt(0).toUpperCase() + provider.slice(1)})` : ''}</li>
          </ul>
        </div>
        ` : ''}

        <div style="background-color: #FEF2F2; border: 1px solid #EF4444; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h4 style="color: #DC2626; margin: 0 0 10px 0; font-size: 16px;">⚠️ Security Notice</h4>
          <ul style="color: #991B1B; margin: 0; padding-left: 20px; font-size: 14px;">
            <li>If you did not ${actionText} your password, please contact our support team immediately at <a href="mailto:${SUPPORT_EMAIL}" style="color: #DC2626; text-decoration: underline;">${SUPPORT_EMAIL}</a></li>
            <li>Keep your password secure and do not share it with anyone</li>
            <li>Consider using a strong, unique password</li>
          </ul>
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.NEXTAUTH_URL}/dashboard" style="display: inline-block; background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(26, 115, 232, 0.3);">Go to Dashboard</a>
        </div>

        <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
          If you have any questions or concerns, please contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.
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

export async function sendProfileUpdateEmail(
  userEmail: string,
  userName: string,
  changedFields?: string[]
): Promise<boolean> {
  const subject = "Profile Updated Successfully";

  // Render the list of fields that actually changed so the customer can
  // verify it was them (and spot an unauthorized change immediately). Falls
  // back to the generic message when the caller didn't supply a list.
  const hasList = Array.isArray(changedFields) && changedFields.length > 0;
  const changedListHtml = hasList
    ? `
          <p style="color: #065F46; margin: 12px 0 6px 0; font-size: 14px; font-weight: bold;">What changed:</p>
          <ul style="color: #065F46; margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.6;">
            ${changedFields
              .map(
                (f) =>
                  `<li>${f.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] || c))}</li>`
              )
              .join("")}
          </ul>`
    : "";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #1A73E8, #1557B0); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: bold;">Profile Updated</h1>
      </div>

      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">Hello ${userName},</p>

        <div style="background-color: #D1FAE5; border: 1px solid #10B981; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #065F46; margin: 0 0 10px 0; font-size: 18px;">✅ Details Updated Successfully</h3>
          <p style="color: #065F46; margin: 0; font-size: 14px;">
            ${hasList
              ? "The following details on your profile were updated. If you did not make these changes, please contact our support team immediately."
              : "Your profile information has been updated. If you did not make these changes, please contact our support team immediately."}
          </p>
          ${changedListHtml}
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.NEXTAUTH_URL}/dashboard" style="display: inline-block; background: linear-gradient(135deg, #1A73E8, #1557B0); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(26, 115, 232, 0.3);">Go to Dashboard</a>
        </div>

        <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
          If you have any questions or concerns, please contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #1A73E8;">${SUPPORT_EMAIL}</a>.
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

export async function sendProfileCompletionEmail(
  userEmail: string,
  userName: string
): Promise<boolean> {
  const profileCompletionUrl = `${process.env.NEXTAUTH_URL}/dashboard/settings`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Complete Your Profile - Anutech Digital Private Limited</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Google Sans', Arial, sans-serif; background-color: #f8f9fa;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
        <div style="background: linear-gradient(135deg, #10b981, #059669); padding: 30px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">📝 Complete Your Profile</h1>
          <p style="color: #d1fae5; margin: 10px 0 0 0; font-size: 16px;">Finish setting up your account</p>
        </div>

        <div style="padding: 30px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin: 0 auto 20px;">
              <tr>
                <td align="center" style="background: linear-gradient(135deg, #10b981, #059669); border-radius: 50%; width: 80px; height: 80px; padding: 0; text-align: center; vertical-align: middle;">
                  <span style="font-size: 40px; line-height: 80px; display: block; height: 80px;">📋</span>
                </td>
              </tr>
            </table>
            <h2 style="color: #374151; margin: 0 0 10px 0; font-size: 20px;">Welcome ${userName}!</h2>
            <p style="color: #6b7280; margin: 0; font-size: 16px;">Your account has been created successfully. Now let's complete your profile.</p>
          </div>

          <div style="background-color: #d1fae5; border: 1px solid #10b981; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
            <h3 style="color: #065f46; margin: 0 0 15px 0; font-size: 16px;">🔐 Profile Completion Required</h3>
            <p style="color: #065f46; margin: 0; line-height: 1.5;">
              To access all features including domain checkout, you need to complete your profile with additional information like phone number, company details, and address.
            </p>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${profileCompletionUrl}"
               style="display: inline-block; background: linear-gradient(135deg, #10b981, #059669); color: #ffffff; text-decoration: none; padding: 16px 32px; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(16, 185, 129, 0.3);">
              Complete My Profile
            </a>
          </div>

          <div style="background-color: #f9fafb; border-radius: 6px; padding: 15px; margin-bottom: 25px;">
            <p style="color: #6b7280; margin: 0 0 10px 0; font-size: 14px; font-weight: bold;">Can't click the button?</p>
            <p style="color: #6b7280; margin: 0; font-size: 14px; word-break: break-all;">
              Copy and paste this link into your browser:<br>
              <span style="color: #10b981; font-weight: bold;">${profileCompletionUrl}</span>
            </p>
          </div>

          <div style="background-color: #d1fae5; border: 1px solid #10b981; border-radius: 8px; padding: 15px; margin-bottom: 25px;">
            <h4 style="color: #065f46; margin: 0 0 10px 0; font-size: 14px; font-weight: bold;">💡 Why Complete Your Profile?</h4>
            <ul style="color: #065f46; margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.5;">
              <li>Access domain checkout and purchase features</li>
              <li>Receive important notifications about your domains</li>
              <li>Get better customer support</li>
              <li>Ensure accurate billing and contact information</li>
            </ul>
          </div>

          <div style="text-align: center; margin-top: 30px;">
            <p style="color: #6b7280; margin: 0 0 15px 0; font-size: 14px;">
              After completing your profile, you'll be able to:
            </p>
            <table style="width: 100%; max-width: 500px; margin: 0 auto; border-collapse: collapse;">
              <tr>
                <td style="text-align: center; vertical-align: top; padding: 0 10px; width: 33.33%;">
                  <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width: 60px; height: 60px; margin: 0 auto 8px; background: #d1fae5; border: 2px solid #10b981; border-radius: 50%;">
                    <tr>
                      <td align="center" style="text-align: center; vertical-align: middle; height: 60px; width: 60px; padding: 0;">
                        <span style="font-size: 28px; line-height: 60px; display: block; height: 60px;">🛒</span>
                      </td>
                    </tr>
                  </table>
                  <p style="color: #374151; margin: 0; font-size: 12px; font-weight: bold; text-align: center;">Checkout Domains</p>
                </td>
                <td style="text-align: center; vertical-align: top; padding: 0 10px; width: 33.33%;">
                  <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width: 60px; height: 60px; margin: 0 auto 8px; background: #d1fae5; border: 2px solid #10b981; border-radius: 50%;">
                    <tr>
                      <td align="center" style="text-align: center; vertical-align: middle; height: 60px; width: 60px; padding: 0;">
                        <span style="font-size: 28px; line-height: 60px; display: block; height: 60px;">📊</span>
                      </td>
                    </tr>
                  </table>
                  <p style="color: #374151; margin: 0; font-size: 12px; font-weight: bold; text-align: center;">View Orders</p>
                </td>
                <td style="text-align: center; vertical-align: top; padding: 0 10px; width: 33.33%;">
                  <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width: 60px; height: 60px; margin: 0 auto 8px; background: #d1fae5; border: 2px solid #10b981; border-radius: 50%;">
                    <tr>
                      <td align="center" style="text-align: center; vertical-align: middle; height: 60px; width: 60px; padding: 0;">
                        <span style="font-size: 28px; line-height: 60px; display: block; height: 60px;">⚙️</span>
                      </td>
                    </tr>
                  </table>
                  <p style="color: #374151; margin: 0; font-size: 12px; font-weight: bold; text-align: center;">Manage DNS</p>
                </td>
              </tr>
            </table>
          </div>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; margin: 0; font-size: 14px;">
            This email was sent to ${userEmail}. If you have any questions, please contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #10b981; font-weight: bold; text-decoration: none;">${SUPPORT_EMAIL}</a>.
          </p>
          <p style="color: #9ca3af; margin: 5px 0 0 0; font-size: 12px;">
            © 2024 Anutech Digital Private Limited. All rights reserved.
            <br>
            <strong>GSTIN: 07ABDCA0298H1ZP</strong>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
  return sendNotificationEmail({
    to: userEmail,
    subject: "📝 Complete Your Profile - Anutech Digital Private Limited",
    html,
  });
}

export async function sendActivationEmail(
  userEmail: string,
  userName: string,
  activationToken: string
): Promise<boolean> {
  const activationUrl = `${
    process.env.APP_URL || process.env.NEXTAUTH_URL || "https://app.anutech.in"
  }/activate?token=${activationToken}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Activate Your Account - Anutech Digital Private Limited</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Google Sans', Arial, sans-serif; background-color: #f8f9fa;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
        <div style="background: linear-gradient(135deg, #1A73E8, #1557B0); padding: 30px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">🎉 Welcome to Anutech Digital Private Limited!</h1>
          <p style="color: #E8F0FE; margin: 10px 0 0 0; font-size: 16px;">Activate your account to get started</p>
        </div>

        <div style="padding: 30px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin: 0 auto 20px;">
              <tr>
                <td align="center" style="background: linear-gradient(135deg, #34A853, #2D8E47); border-radius: 50%; width: 80px; height: 80px; padding: 0; text-align: center; vertical-align: middle;">
                  <span style="color: #ffffff; font-size: 48px; font-weight: bold; line-height: 80px; display: block; height: 80px;">✓</span>
                </td>
              </tr>
            </table>
            <h2 style="color: #374151; margin: 0 0 10px 0; font-size: 20px;">Account Created Successfully!</h2>
            <p style="color: #6b7280; margin: 0; font-size: 16px;">Hi ${userName}, your account has been created and is ready for activation.</p>
          </div>

          <div style="background-color: #E8F0FE; border: 1px solid #1A73E8; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
            <h3 style="color: #1557B0; margin: 0 0 15px 0; font-size: 16px;">🔐 Account Activation Required</h3>
            <p style="color: #1557B0; margin: 0; line-height: 1.5;">
              To complete your registration and access your dashboard, please click the activation button below.
              This ensures the security of your account and verifies your email address.
            </p>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${activationUrl}"
               style="display: inline-block; background: linear-gradient(135deg, #34A853, #2D8E47); color: #ffffff; text-decoration: none; padding: 16px 32px; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(52, 168, 83, 0.3);">
              Activate My Account
            </a>
          </div>

          <div style="background-color: #f9fafb; border-radius: 6px; padding: 15px; margin-bottom: 25px;">
            <p style="color: #6b7280; margin: 0 0 10px 0; font-size: 14px; font-weight: bold;">Can't click the button?</p>
            <p style="color: #6b7280; margin: 0; font-size: 14px; word-break: break-all;">
              Copy and paste this link into your browser:<br>
              <span style="color: #1A73E8;">${activationUrl}</span>
            </p>
          </div>

          <div style="background-color: #FEF3C7; border: 1px solid #F59E0B; border-radius: 8px; padding: 15px; margin-bottom: 25px;">
            <h4 style="color: #92400E; margin: 0 0 10px 0; font-size: 14px;">⏰ Important Notes</h4>
            <ul style="color: #92400E; margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.5;">
              <li>This activation link will expire in 24 hours</li>
              <li>If the link expires, you can request a new one from the login page</li>
              <li>Keep your login credentials secure and don't share them</li>
            </ul>
          </div>

          <div style="text-align: center; margin-top: 30px;">
            <p style="color: #6b7280; margin: 0; font-size: 14px;">
              Once activated, you'll be able to:
            </p>
            <div style="display: table; margin: 15px auto 0; text-align: center;">
              <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="text-align: center; padding: 0 15px;">
                    <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width: 50px; height: 50px; background: #E8F0FE; border-radius: 50%; margin: 0 auto 8px;">
                      <tr>
                        <td align="center" style="text-align: center; vertical-align: middle; height: 50px; width: 50px; padding: 0;">
                          <span style="font-size: 24px; line-height: 50px; display: block; height: 50px;">🌐</span>
                        </td>
                      </tr>
                    </table>
                    <p style="color: #374151; margin: 0; font-size: 12px; font-weight: bold;">Search Domains</p>
                  </td>
                  <td style="text-align: center; padding: 0 15px;">
                    <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width: 50px; height: 50px; background: #E8F0FE; border-radius: 50%; margin: 0 auto 8px;">
                      <tr>
                        <td align="center" style="text-align: center; vertical-align: middle; height: 50px; width: 50px; padding: 0;">
                          <span style="font-size: 24px; line-height: 50px; display: block; height: 50px;">🛒</span>
                        </td>
                      </tr>
                    </table>
                    <p style="color: #374151; margin: 0; font-size: 12px; font-weight: bold;">Manage Cart</p>
                  </td>
                  <td style="text-align: center; padding: 0 15px;">
                    <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width: 50px; height: 50px; background: #E8F0FE; border-radius: 50%; margin: 0 auto 8px;">
                      <tr>
                        <td align="center" style="text-align: center; vertical-align: middle; height: 50px; width: 50px; padding: 0;">
                          <span style="font-size: 24px; line-height: 50px; display: block; height: 50px;">📊</span>
                        </td>
                      </tr>
                    </table>
                    <p style="color: #374151; margin: 0; font-size: 12px; font-weight: bold;">View Dashboard</p>
                  </td>
                </tr>
              </table>
            </div>
          </div>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; margin: 0; font-size: 14px;">
            This email was sent to ${userEmail}. If you didn't create an account, please ignore this email.
          </p>
          <p style="color: #9ca3af; margin: 5px 0 0 0; font-size: 12px;">
            © 2024 Anutech Digital Private Limited. All rights reserved.
            <br>
            <strong>GSTIN: 07ABDCA0298H1ZP</strong>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
  return sendEmail({
    to: userEmail,
    subject: "🎉 Activate Your Account - Anutech Digital Private Limited",
    html,
  });
}
