import nodemailer from "nodemailer";
import { lookup } from "node:dns/promises";
import validator from "validator";
import { serverLogger } from "@/lib/server-logger";

export const SMTP_HOST = process.env.SMTP_HOST;
export const SMTP_PORT = process.env.SMTP_PORT;
export const SMTP_SECURE = process.env.SMTP_SECURE === "true";
export const SMTP_USER = process.env.SMTP_USER;
export const SMTP_PASS = process.env.SMTP_PASS;
export const FROM_EMAIL = process.env.FROM_EMAIL;
export const FROM_NAME = process.env.FROM_NAME;
export const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@anutech.in";

if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !FROM_EMAIL) {
  throw new Error("Email configuration is missing");
}

// SPF alignment warning: FROM_EMAIL domain should match the authenticated SMTP_USER domain.
// A mismatch means the From header domain differs from the smtp.mailfrom domain, which
// causes strict SPF alignment failures and may trigger DMARC rejections or spam filtering.
const fromDomain = FROM_EMAIL.split("@")[1]?.toLowerCase();
const smtpDomain = SMTP_USER!.split("@")[1]?.toLowerCase();
if (fromDomain && smtpDomain && fromDomain !== smtpDomain) {
  serverLogger.warn(
    `[Email] SPF alignment warning: FROM_EMAIL domain (${fromDomain}) ` +
      `differs from SMTP_USER domain (${smtpDomain}). ` +
      "Ensure DKIM is configured for the From domain, or messages may be rejected by DMARC."
  );
}

let cachedTransporter: nodemailer.Transporter | null = null;

export async function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  try {
    /* Connect over IPv4 (30 Sep 2026). smtp.gmail.com resolves to IPv6 first, which a
       host without IPv6 egress (this machine, Cloud Run by default) cannot reach: the
       first send hung 21 s on the TCP timeout before falling back. The certificate is
       still checked against the real name via servername. Same fix as ResellerOS
       lib/email/smtp-transport.ts. */
    const ipv4 = await lookup(SMTP_HOST!, { family: 4 }).then((a) => a.address).catch(() => null);
    const transporter = nodemailer.createTransport({
      host: ipv4 ?? SMTP_HOST,
      tls: { servername: SMTP_HOST },
      port: parseInt(SMTP_PORT || "587"),
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
    await transporter.verify();
    cachedTransporter = transporter;
    return transporter;
  } catch (error) {
    serverLogger.error("Failed to create email transporter:", error);
    throw new Error("Email transporter configuration failed");
  }
}

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // When set, adds RFC 8058 one-click unsubscribe headers so Gmail/Yahoo/
  // Outlook render a native "Unsubscribe" control and bulk-sender rules are
  // satisfied. Only supplied for non-essential notification emails.
  listUnsubscribeUrl?: string;
  // Overrides the default Reply-To (SUPPORT_EMAIL). Emails send FROM the
  // no-reply mailbox, but replies must land somewhere monitored.
  replyTo?: string;
}

/**
 * Record one send attempt (models/EmailLog.ts, 7 Oct 2026). Best-effort: a log that cannot be
 * written must never stop or fail the email itself, so every error here is swallowed.
 */
async function recordEmail(row: { to: string; subject: string; status: "sent" | "failed" | "skipped"; messageId?: string; response?: string; error?: string }): Promise<void> {
  try {
    const [{ default: connectDB }, { default: EmailLog }] = await Promise.all([
      import("@/lib/mongodb"),
      import("@/models/EmailLog"),
    ]);
    await connectDB();
    await EmailLog.create({
      ...row,
      subject: row.subject.slice(0, 300),
      ...(row.response ? { response: row.response.slice(0, 300) } : {}),
      ...(row.error ? { error: row.error.slice(0, 500) } : {}),
    });
  } catch (err) {
    serverLogger.warn("[Email] could not record the send:", err);
  }
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  if (!validator.isEmail(options.to)) {
    serverLogger.error(`[Email] Invalid recipient address: "${options.to}"`);
    void recordEmail({ to: String(options.to).slice(0, 200), subject: options.subject, status: "skipped", error: "invalid recipient address" });
    return false;
  }
  // No recipient filter (owner, 30 Sep 2026): the EMAIL_RECIPIENT_ALLOWLIST of 29 Sep was
  // removed from the code so every recipient is mailed, locally too.
  try {
    const transporter = await getTransporter();
    const mailOptions: nodemailer.SendMailOptions = {
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      // Replies go to a monitored inbox, not the unattended no-reply mailbox.
      replyTo: options.replyTo || SUPPORT_EMAIL,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    };
    if (options.listUnsubscribeUrl) {
      // RFC 8058 one-click unsubscribe. The mailto gives a fallback for
      // clients that don't support HTTPS one-click.
      mailOptions.headers = {
        "List-Unsubscribe": `<${options.listUnsubscribeUrl}>, <mailto:${SUPPORT_EMAIL}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      };
    }
    const info = await transporter.sendMail(mailOptions);
    void recordEmail({ to: options.to, subject: options.subject, status: "sent", messageId: info?.messageId, response: info?.response });
    return true;
  } catch (error) {
    serverLogger.error("Email sending error:", error);
    void recordEmail({ to: options.to, subject: options.subject, status: "failed", error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
