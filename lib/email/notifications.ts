import { sendEmail } from "./transporter";
import { SUPPORT_EMAIL } from "./transporter";
import { unsubscribeUrl } from "@/lib/unsubscribe-token";
import { getUserByEmail } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";

/**
 * Send a NON-ESSENTIAL notification email (marketing + service reminders).
 *
 * Unlike transactional/legal/security mail (password reset, invoices,
 * activation, "profile changed" alerts) — which always send — these emails:
 *   1. are SUPPRESSED when the recipient has unsubscribed (`emailOptOut`);
 *   2. carry a visible unsubscribe footer; and
 *   3. set RFC 8058 one-click `List-Unsubscribe` headers.
 *
 * Route the 5 non-essential senders through this instead of `sendEmail`.
 * Returns true when sent OR intentionally suppressed (both are "success"
 * from the caller's perspective — nothing went wrong).
 */
export async function sendNotificationEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<boolean> {
  // Respect the opt-out. A lookup miss (guest / not-yet-created user) falls
  // through to sending — we only suppress when we positively know they opted
  // out. Never let a lookup error block the send.
  try {
    const user = await getUserByEmail(opts.to);
    if (user?.emailOptOut === true) {
      serverLogger.info(
        `[Email] Suppressed non-essential email "${opts.subject}" → ${opts.to} (unsubscribed)`
      );
      return true;
    }
  } catch (err) {
    serverLogger.warn(
      `[Email] opt-out lookup failed for ${opts.to}; sending anyway:`,
      err
    );
  }

  const url = unsubscribeUrl(opts.to);
  const html = `${opts.html}${unsubscribeFooterHtml(url)}`;

  return sendEmail({
    to: opts.to,
    subject: opts.subject,
    html,
    text: opts.text,
    listUnsubscribeUrl: url,
  });
}

/** Footer appended to non-essential emails with the unsubscribe link. */
export function unsubscribeFooterHtml(url: string): string {
  return `
    <div style="max-width: 600px; margin: 0 auto; padding: 16px 24px; text-align: center;">
      <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5;">
        You're receiving this because you have an account with Anutech Digital.
        This is an optional notification — you'll still receive important account,
        billing, and security emails.<br>
        <a href="${url}" style="color: #6b7280; text-decoration: underline;">Unsubscribe from these notifications</a>
        &nbsp;·&nbsp;
        <a href="mailto:${SUPPORT_EMAIL}" style="color: #6b7280; text-decoration: underline;">Contact support</a>
      </p>
    </div>`;
}
