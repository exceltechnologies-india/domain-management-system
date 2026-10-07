import { sendEmail, SUPPORT_EMAIL } from "./transporter";
import { sendNotificationEmail } from "./notifications";
import { brandName, firstName, plainEmailHtml, portalLoginUrl } from "./plain";

/*
 * Account emails to the customer, in the ResellerOS pattern (lib/email/plain.ts; owner,
 * 3 Oct 2026: DMS is a backend for ResellerOS, so its customer emails must read like
 * ResellerOS's — plain, personal text, no banners, gradients, emoji or "Team" sign-off).
 * What each one SAYS is unchanged: every link (reset incl. &setup=1, activation), every
 * expiry, every "if this wasn't you" note and the list of changed fields.
 */

function send(to: string, subject: string, text: string): Promise<boolean> {
  return sendEmail({ to, subject, text, html: plainEmailHtml(text) });
}

function helpLines(): string {
  return `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.\n\n— ${brandName()}`;
}

function appUrl(): string {
  return `${process.env.NEXTAUTH_URL}`;
}

export async function sendWelcomeEmail(
  userEmail: string,
  userName: string
): Promise<boolean> {
  const subject = `Welcome to ${brandName()}`;
  const text =
`Hi ${firstName(userName)},

Thank you for creating an account with us. You can now search for available domains, buy domains securely, manage your DNS records and keep track of all your domains.

Get started from your dashboard:
  ${appUrl()}/dashboard

${helpLines()}`;
  return send(userEmail, subject, text);
}

export async function sendPasswordResetEmail(
  userEmail: string,
  userName: string,
  resetToken: string,
  /** When true, the email is framed as a first-time account setup
   * (guest → full account) rather than a recovery flow. */
  isSetup: boolean = false
): Promise<boolean> {
  const subject = isSetup ? "Set up your account password" : "Password reset request";
  const resetUrl = `${appUrl()}/reset-password?token=${resetToken}${isSetup ? "&setup=1" : ""}`;
  const intro = isSetup
    ? "Thanks for your recent purchase! To finish setting up your account, set your password here:"
    : "You asked to reset your password. Reset it here:";
  const ignore = isSetup
    ? "If you didn't sign up, you can safely ignore this email."
    : "If you didn't ask for a password reset, please ignore this email — your password stays the same.";

  const text =
`Hi ${firstName(userName)},

${intro}
  ${resetUrl}

This link expires in 1 hour for security reasons. ${ignore}

${helpLines()}`;
  return send(userEmail, subject, text);
}

/**
 * A new Customer Portal account, with a one-time password to sign in straight away (Pawan,
 * 7 Oct 2026: "send the one time generated password for direct login, then let the user
 * generate their own password"). The portal asks for their own password at the first sign-in.
 */
export async function sendAccountCreatedEmail(
  userEmail: string,
  userName: string,
  tempPassword: string
): Promise<boolean> {
  const subject = "Your Customer Portal is ready";
  const text =
`Hi ${firstName(userName)},

Thanks for your purchase! Your Customer Portal is ready — sign in to manage your hosting, domains and invoices:
  ${portalLoginUrl()}

  Email: ${userEmail}
  One-time password: ${tempPassword}

When you sign in, we ask you to choose your own password; this one stops working then. Please don't share it with anyone. If you didn't buy anything from us, write to us and we will close the account.

${helpLines()}`;
  return send(userEmail, subject, text);
}

export async function sendPasswordResetNotificationEmail(
  userEmail: string,
  userName: string,
  newPassword: string
): Promise<boolean> {
  const subject = "Your password has been reset";
  const text =
`Hi ${firstName(userName)},

Your password has been reset by an administrator. Your new password is:
  ${newPassword}

Please sign in now and change it to a secure password of your own:
  ${appUrl()}/login

Do not share this password with anyone; a password manager helps keep it safe. If you weren't expecting this, write to us straight away.

${helpLines()}`;
  return send(userEmail, subject, text);
}

function providerLabel(provider?: string): string {
  if (!provider || provider === "credentials") return "";
  return provider === "google" ? " (Google)" : ` (${provider.charAt(0).toUpperCase() + provider.slice(1)})`;
}

export async function sendPasswordChangeNotificationEmail(
  userEmail: string,
  userName: string,
  isFirstTimeSet: boolean = false,
  provider?: string
): Promise<boolean> {
  const subject = isFirstTimeSet ? "Password set successfully" : "Password changed successfully";
  const actionText = isFirstTimeSet ? "set" : "changed";

  const loginOptions = isFirstTimeSet
    ? `\n\nYou can now sign in either with your email and this new password, or with your social login account${providerLabel(provider)}.`
    : "";

  const text =
`Hi ${firstName(userName)},

Your password has been ${actionText} successfully. You can now use your email and password to sign in to your account.${loginOptions}

If you did not ${isFirstTimeSet ? "set" : "change"} your password yourself, write to us immediately at ${SUPPORT_EMAIL}. Keep your password secure, use a strong one you don't use elsewhere, and don't share it with anyone.

Your dashboard:
  ${appUrl()}/dashboard

${helpLines()}`;
  return send(userEmail, subject, text);
}

export async function sendProfileUpdateEmail(
  userEmail: string,
  userName: string,
  changedFields?: string[]
): Promise<boolean> {
  const subject = "Profile updated successfully";

  // List the fields that actually changed so the customer can verify it was them (and
  // spot an unauthorized change immediately). Falls back to the generic message when the
  // caller didn't supply a list. plainEmailHtml escapes the labels in the HTML part.
  const hasList = Array.isArray(changedFields) && changedFields.length > 0;
  const body = hasList
    ? `These details on your profile were updated:\n${changedFields.map((f) => `  - ${f}`).join("\n")}`
    : "Your profile information has been updated.";

  const text =
`Hi ${firstName(userName)},

${body}

If you did not make these changes, write to us immediately at ${SUPPORT_EMAIL}.

Your dashboard:
  ${appUrl()}/dashboard

${helpLines()}`;
  return send(userEmail, subject, text);
}

export async function sendProfileCompletionEmail(
  userEmail: string,
  userName: string
): Promise<boolean> {
  const profileCompletionUrl = `${appUrl()}/dashboard/settings`;
  const text =
`Hi ${firstName(userName)},

Your account has been created. One step is left: complete your profile with your phone number, company details and address. You need it to check out domains, view your orders and manage DNS — and it means you get important notices about your domains, better support, and accurate billing and contact details.

Complete your profile here:
  ${profileCompletionUrl}

This email was sent to ${userEmail}.

${helpLines()}`;
  return sendNotificationEmail({
    to: userEmail,
    subject: "Complete your profile",
    text,
    html: plainEmailHtml(text),
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

  const text =
`Hi ${firstName(userName)},

Your ${brandName()} account has been created. To finish registering and open your dashboard, activate it here — this confirms your email address and keeps your account secure:
  ${activationUrl}

This link expires in 24 hours. If it expires, you can ask for a new one from the sign-in page. Once activated, you can search for domains, manage your cart and use your dashboard.

This email was sent to ${userEmail}. If you didn't create an account, please ignore it.

${helpLines()}`;
  return send(userEmail, "Activate your account", text);
}
