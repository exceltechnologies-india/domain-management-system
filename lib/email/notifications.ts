import { sendEmail } from "./transporter";
import { plainEmailHtml } from "./plain";
import { unsubscribeUrl } from "@/lib/unsubscribe-token";
import { getUserByEmail } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";

/**
 * Send a NON-ESSENTIAL notification email (marketing + service reminders).
 *
 * Unlike transactional/legal/security mail (password reset, invoices,
 * activation, "profile changed" alerts) — which always send — these emails:
 *   1. are SUPPRESSED when the recipient has unsubscribed (`emailOptOut`);
 *   2. end with a plain "Don't want these emails? Unsubscribe: <url>" line
 *      after the sign-off (the ResellerOS pattern, lib/email/plain.ts); and
 *   3. set RFC 8058 one-click `List-Unsubscribe` headers.
 *
 * Route the 5 non-essential senders through this instead of `sendEmail`.
 * Returns true when sent OR intentionally suppressed (both are "success"
 * from the caller's perspective — nothing went wrong).
 */
export async function sendNotificationEmail(opts: {
  to: string;
  subject: string;
  /** The plain-text body in the ResellerOS pattern (lib/email/plain.ts). When given, the
   *  email is sent as that text + its plainEmailHtml rendering, with the unsubscribe link
   *  as a plain last line after the sign-off — any `html` passed alongside is ignored. */
  text?: string;
  /** Only for a caller not yet moved to `text`: its HTML gets the plain unsubscribe line. */
  html?: string;
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

  if (opts.text) {
    const text = `${opts.text}\n\n${unsubscribeLine(url)}`;
    return sendEmail({
      to: opts.to,
      subject: opts.subject,
      text,
      html: plainEmailHtml(text),
      listUnsubscribeUrl: url,
    });
  }

  return sendEmail({
    to: opts.to,
    subject: opts.subject,
    html: `${opts.html ?? ""}${unsubscribeFooterHtml(url)}`,
    listUnsubscribeUrl: url,
  });
}

/** The unsubscribe link as one plain line, placed after the sign-off (ResellerOS pattern). */
export function unsubscribeLine(url: string): string {
  return `Don't want these emails? Unsubscribe: ${url}`;
}

/** The same line as HTML, for a caller that still sends its own HTML body. No styling. */
export function unsubscribeFooterHtml(url: string): string {
  return plainEmailHtml(`\n\n${unsubscribeLine(url)}`);
}
