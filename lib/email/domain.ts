import { sendEmail, SUPPORT_EMAIL } from "./transporter";
import type { RenewalReminderLink } from "@/lib/reselleros/renewal-reminder-link";
import { sendNotificationEmail } from "./notifications";
import { formatIndianDate } from "../dateUtils";
import { brandName, firstName, plainEmailHtml } from "./plain";

/*
 * Domain and service-lifecycle emails to the customer, in the ResellerOS pattern
 * (lib/email/plain.ts; owner, 3 Oct 2026: DMS is a backend for ResellerOS, so its customer
 * emails must read exactly like ResellerOS's). Rewritten from the earlier banner, gradient and
 * table layout into plain signed text. What each one SAYS is unchanged: every domain, date,
 * price, day count, link, grace-period and suspension fact is the same as before.
 */

/** A transactional email (always sent). */
function send(to: string, subject: string, text: string): Promise<boolean> {
  return sendEmail({ to, subject, text, html: plainEmailHtml(text) });
}

/** A non-essential notification: opt-out respected, and lib/email/notifications.ts adds the
 *  plain unsubscribe line after the sign-off. */
function notify(to: string, subject: string, text: string): Promise<boolean> {
  return sendNotificationEmail({ to, subject, text, html: plainEmailHtml(text) });
}

function helpLines(): string {
  return `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.\n\n— ${brandName()}`;
}

function appUrl(path: string): string {
  return `${process.env.NEXTAUTH_URL ?? ""}${path}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n !== 1 ? "s" : ""}`;
}

export async function sendDomainPurchaseEmail(
  userEmail: string,
  userName: string,
  domains: Array<{ domainName: string; price: number; status: string }>,
  totalAmount: number
): Promise<boolean> {
  const subject = "Domain Purchase Confirmation";
  const domainList = domains
    .map((domain) => `  ${domain.domainName} — ₹${domain.price} (${domain.status})`)
    .join("\n");

  const text =
`Hi ${firstName(userName)},

Your domain purchase has been processed successfully.

${domainList}
  Total: ₹${totalAmount}

You can manage your domains from your dashboard:
  ${appUrl("/dashboard")}

${helpLines()}`;
  return send(userEmail, subject, text);
}

export async function sendDomainRegistrationEmail(
  userEmail: string,
  userName: string,
  domains: Array<{ domainName: string; expiresAt: Date }>
): Promise<boolean> {
  const subject = "Domain Registration Successful";
  const domainList = domains
    .map((domain) => `  ${domain.domainName} — expires ${formatIndianDate(domain.expiresAt)}`)
    .join("\n");

  const text =
`Hi ${firstName(userName)},

Your domains have been registered:

${domainList}

You can now manage their DNS records and settings here:
  ${appUrl("/dashboard/dns-management")}

${helpLines()}`;
  return send(userEmail, subject, text);
}

export async function sendDomainRegistrationFailureEmail(
  userEmail: string,
  userName: string,
  domains: Array<{ domainName: string; error: string }>
): Promise<boolean> {
  const subject = "Domain Registration Issue";
  const domainList = domains
    .map((domain) => `  ${domain.domainName} — ${domain.error}`)
    .join("\n");

  const text =
`Hi ${firstName(userName)},

We ran into a problem registering these domains:

${domainList}

Our team has been notified and is looking into it. You will receive a refund for any registration that fails.

${helpLines()}`;
  return send(userEmail, subject, text);
}

// sendRenewalInvoiceEmail was deleted on 26 Sep 2026: it emailed a DMS-raised
// renewal amount, and nothing has called it since the expiry worker stopped
// raising DMS renewal orders (renewals are ResellerOS's).

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
  const orderStatusUrl = orderId ? appUrl(`/dashboard/orders/${orderId}`) : null;

  const activeDomains = domains.filter((d) => d.status === "registered");
  const pendingDomains = domains.filter(
    (d) => d.status === "pending" || d.status === "processing"
  );

  const activeBlock = activeDomains.length
    ? `\n\nRegistered and active:\n${activeDomains
        .map(
          (d) =>
            `  ${d.domainName} — registered for ${plural(d.registrationPeriod, "year")}${d.expiresAt ? `, expires ${formatIndianDate(d.expiresAt)}` : ""}`
        )
        .join("\n")}`
    : "";

  const pendingBlock = pendingDomains.length
    ? `\n\nStill being processed:\n${pendingDomains.map((d) => `  ${d.domainName}`).join("\n")}\n\nOur team is finalising these registrations and they will be active shortly. Some domains need a technical verification, which our administrators are handling by hand to make sure the registration succeeds. You will get another confirmation once they are active.`
    : "";

  const links = orderStatusUrl
    ? `Track this order:\n  ${orderStatusUrl}\nYour domains (status, DNS and details):\n  ${appUrl("/dashboard/domains")}`
    : `Track status, manage DNS and see details for your domains here:\n  ${appUrl("/dashboard/domains")}`;

  const text =
`Hi ${firstName(userName)},

Thank you for choosing ${brandName()}. We have received your domain booking and started processing it. This is where your domains stand:${activeBlock}${pendingBlock}

${links}

${helpLines()}`;
  return send(userEmail, subject, text);
}

/**
 * The expiry reminder. Since 26 Sep 2026 (owner: "Point to the ResellerOS
 * quote") it carries NO price: renewals are billed by ResellerOS, and the only
 * pay link is the customer's pending ResellerOS renewal quote. `renewal` says
 * which of four things to tell them (lib/reselleros/renewal-reminder-link.ts).
 * A source scan (tests/unit/lib/email/reminder-no-dms-price.test.ts) fails if a
 * price field comes back.
 */
export async function sendServiceReminderEmail(
  userEmail: string,
  details: {
    serviceName: string;
    serviceType: string;
    daysRemaining: number;
    renewal: RenewalReminderLink;
    userName?: string;
  }
): Promise<boolean> {
  const isUrgent = details.daysRemaining <= 1;
  const days = plural(details.daysRemaining, "day");

  const renewalBlock =
    details.renewal.kind === "pay"
      ? `Your renewal bill is ready. Pay it to keep your service running — the total is shown on the bill. View and pay it here:\n  ${details.renewal.paymentUrl}`
      : details.renewal.kind === "choose"
        ? `You have ${details.renewal.count} bills waiting for payment. Open your bills and pay the renewal bill for ${details.serviceName}:\n  ${details.renewal.invoicesUrl}`
        : details.renewal.kind === "preparing"
          ? "Your renewal bill is being prepared. It will be emailed to you by our billing system, with a link to pay it."
          : "Your renewal bill comes from our billing system and is emailed to you. If you haven't received it, reply to this email or contact our support team.";

  const subject = isUrgent
    ? `URGENT: Your ${details.serviceType} ${details.serviceName} expires TODAY`
    : `Renewal Reminder: ${details.serviceName} expires in ${days}`;

  const opening = isUrgent
    ? `Your ${details.serviceType} ${details.serviceName} expires ${details.daysRemaining <= 0 ? "today" : `in ${days}`} and needs your action now. Renew it to avoid service interruption.`
    : `Your ${details.serviceType} ${details.serviceName} will expire in ${days}. Renew before then to avoid service interruption.`;

  const text =
`Hi ${firstName(details.userName)},

${opening}

  Service: ${details.serviceName}
  Type: ${details.serviceType}
  Days remaining: ${days}

${renewalBlock}

${helpLines()}`;
  return notify(userEmail, subject, text);
}

export async function sendServiceExpiryTodayEmail(
  userEmail: string,
  details: { serviceName: string; serviceType: string; userName?: string }
): Promise<boolean> {
  const dashboardPath = details.serviceType === "hosting" ? "/dashboard/hosting" : "/dashboard/domains";
  const renewUrl = `${process.env.NEXTAUTH_URL || ""}${dashboardPath}`;
  const subject = `URGENT: Your ${details.serviceType} ${details.serviceName} expires TODAY`;

  const text =
`Hi ${firstName(details.userName)},

Your ${details.serviceType} ${details.serviceName} expires today. If it is not renewed, it will be suspended automatically.

To keep it running without interruption, please renew it now from your dashboard:
  ${renewUrl}

${helpLines()}`;
  return notify(userEmail, subject, text);
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

  // Recovery-path copy varies by mandate mode. Tokens-flow gets a
  // specific re-subscribe step because their mandate is dead; the
  // others get the generic contact-support fallback.
  const recovery =
    details.mandateMode === "tokens"
      ? `What happened: your saved payment method couldn't be charged for the renewal of this ${details.serviceType}. Under our renewal policy each recurring charge is attempted once — if it fails, the service is suspended immediately and the payment mandate is closed. Common causes: a card expired or replaced, not enough balance at the moment of the charge, or a UPI mandate that was revoked in your bank app.

How to restore service: sign in to your dashboard, choose ${details.serviceName}, and re-subscribe with a fresh card or UPI ID. A new mandate will be set up and your hosting will be reactivated as soon as the first charge succeeds.
  ${dashboardUrl}`
      : `Please contact support to resolve this and restore the service. Your dashboard:
  ${dashboardUrl}`;

  const text =
`Hi there,

Your ${details.serviceType} ${details.serviceName} has been suspended because a renewal payment failed.

${recovery}

${helpLines()}`;
  return send(userEmail, subject, text);
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

  const text =
`Hi there,

Your ${details.serviceType} ${details.serviceName} has expired. It is now in a ${details.graceDays}-day grace period and will be suspended on ${graceEndFormatted} if it is not renewed.

During the grace period it stays accessible. Please renew it now to avoid the suspension:
  ${dashboardUrl}

${helpLines()}`;
  return notify(userEmail, subject, text);
}

export async function sendDomainAvailableEmail(
  userEmail: string,
  domainName: string,
  userName?: string
): Promise<boolean> {
  const searchUrl = `${process.env.NEXTAUTH_URL ?? ""}/domain-search?q=${encodeURIComponent(domainName)}`;
  const subject = `Good news! ${domainName} is now available`;

  const text =
`Hi ${firstName(userName)},

${domainName}, a domain you were watching, is now available to register. Popular domains get taken quickly, so don't wait too long:
  ${searchUrl}

You won't get more notifications for this domain unless you add it to your watch list again.

${helpLines()}`;
  return notify(userEmail, subject, text);
}
