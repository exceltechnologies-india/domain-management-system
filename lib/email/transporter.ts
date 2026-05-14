import nodemailer from "nodemailer";
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
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
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
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  if (!validator.isEmail(options.to)) {
    serverLogger.error(`[Email] Invalid recipient address: "${options.to}"`);
    return false;
  }
  try {
    const transporter = await getTransporter();
    const mailOptions = {
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    };
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    serverLogger.error("Email sending error:", error);
    return false;
  }
}
