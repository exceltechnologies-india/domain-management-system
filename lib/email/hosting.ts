import { sendEmail, SUPPORT_EMAIL } from "./transporter";
import { brandName, firstName, plainEmailHtml, portalLoginUrl } from "./plain";

/*
 * Hosting emails to the customer, in the ResellerOS pattern (lib/email/plain.ts; Pawan,
 * 3 Oct 2026). Rewritten from the earlier banner-and-gradient layout so a customer gets the
 * same plain, signed email whether they bought on the ResellerOS site or in the panel. What
 * each one SAYS is unchanged: the trial line, the Tokens-flow renewal warning (paid only, never
 * on a ₹0 trial), the nameservers and server IP, and where to get help.
 */

function send(to: string, subject: string, text: string): Promise<boolean> {
  return sendEmail({ to, subject, text, html: plainEmailHtml(text) });
}

function helpLines(): string {
  return `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.\n\n— ${brandName()}`;
}

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
    // policy (d4b6a64), so their (paid) email says so up front.
    // Subscriptions-flow + manual customers default to undefined → nothing extra.
    mandateMode?: "tokens" | "subscriptions" | "manual";
    // A trial says it is a trial, and until when (added 2026-07-03).
    isTrial?: boolean;
    trialEndsAt?: Date | string | null;
  }
): Promise<boolean> {
  const isTrial = hostingDetails.isTrial === true;
  const trialEnds = isTrial && hostingDetails.trialEndsAt ? new Date(hostingDetails.trialEndsAt) : null;
  const trialEndsLabel =
    trialEnds && !isNaN(trialEnds.getTime())
      ? trialEnds.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
      : null;
  const plan = hostingDetails.planName || hostingDetails.packageName;
  const domain = hostingDetails.domainName;

  const subject = isTrial
    ? `Your 15-day ${plan} hosting trial is live — ${domain}`
    : `Your ${plan} hosting is live — ${domain}`;

  const opening = isTrial
    ? `Your 15-day ${plan} hosting trial for ${domain} is ready${trialEndsLabel ? ` — free until ${trialEndsLabel}` : ""}. No credit card, nothing charged.`
    : `Your ${plan} hosting for ${domain} is ready.`;

  /* Paid Tokens-flow only. Not on a trial: nothing has been charged, and a second
     "or you'll be suspended" line reads as alarming on a ₹0 trial (operator, 2026-07-27). */
  const renewal =
    hostingDetails.mandateMode === "tokens" && !isTrial
      ? `\n\nYour hosting renews automatically: we charge the card or UPI ID you saved once, when the next term is due. If that single charge fails, the hosting is suspended and you would need to subscribe again with a new payment method — so please keep it valid.`
      : "";

  const pointing = hostingDetails.nameservers.length
    ? `\n\nTo put your website on it, point ${domain} to these nameservers at your domain registrar (already done if you bought the domain from us):\n${hostingDetails.nameservers.map((ns) => `  ${ns}`).join("\n")}\nServer IP: ${hostingDetails.serverIp}`
    : `\n\nServer IP: ${hostingDetails.serverIp}`;

  const text =
`Hi ${firstName(userName)},

${opening}

Manage it — control panel, email, WordPress — from your Customer Portal:
  ${portalLoginUrl()}
First time there? Use the "set your password" email we sent you to sign in.${pointing}${renewal}

Moving from another host? Reply to this email with your current login and we'll migrate you for free — your old site stays live until you approve the switch.

${helpLines()}`;

  return send(userEmail, subject, text);
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
  const text =
`Hi ${firstName(userName)},

Your 15-day free trial for ${details.domainName} has been cancelled and the hosting has been switched off. You have not been charged, and no payment will be taken later — your saved payment mandate has been cancelled.

The hosting account won't renew, and if you had put a website on it, its files are no longer served. Nothing more is needed from you.

Changed your mind, or cancelled by accident? Reply to this email and we'll set you up again.

${helpLines()}`;
  return send(userEmail, subject, text);
}

/**
 * The hosting account was terminated by our team (admin → Hosting → Terminate; Pawan,
 * 3 Oct 2026: "when hosting is removed, send an email like the DMS panel does"). Sent
 * after the account is gone, so it states what was removed rather than what will be.
 */
export async function sendHostingTerminatedEmail(
  userEmail: string,
  userName: string,
  details: { domainName: string }
): Promise<boolean> {
  const subject = `Your hosting for ${details.domainName} has been removed`;
  const text =
`Hi ${firstName(userName)},

The hosting account for ${details.domainName} has been removed from our servers. Its website files, databases and email accounts have been deleted, and it will not be billed again.

If you weren't expecting this, or you'd like the hosting back, reply to this email and we'll help straight away.

${helpLines()}`;
  return send(userEmail, subject, text);
}
