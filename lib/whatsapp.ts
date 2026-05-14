import { serverLogger } from "@/lib/server-logger";

const GRAPH_URL = "https://graph.facebook.com/v18.0";

/**
 * WhatsApp Cloud API (Meta) — sends pre-approved template messages.
 *
 * Required env vars:
 *   WHATSAPP_API_TOKEN      — Meta permanent / long-lived access token
 *   WHATSAPP_PHONE_NUMBER_ID — Phone number ID from Meta Business dashboard
 *
 * Template env vars (override to match your approved template names):
 *   WHATSAPP_TEMPLATE_REMINDER   (default: "service_renewal_reminder")
 *   WHATSAPP_TEMPLATE_PAYMENT    (default: "payment_confirmed")
 *   WHATSAPP_TEMPLATE_SUSPENDED  (default: "service_suspended")
 *
 * All numbers are assumed to be 10-digit Indian mobile numbers (+91 prefix added).
 */
export class WhatsAppService {
  private static get token() { return process.env.WHATSAPP_API_TOKEN; }
  private static get phoneNumberId() { return process.env.WHATSAPP_PHONE_NUMBER_ID; }

  static isConfigured(): boolean {
    return !!(this.token && this.phoneNumberId);
  }

  /** Normalise to E.164 format, assuming India (+91) for 10-digit numbers. */
  static formatNumber(raw: string): string {
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
    if (digits.length === 10) return `+91${digits}`;
    return `+${digits}`;
  }

  /**
   * Send a template message. Body parameters are substituted into {{1}}, {{2}}, …
   * in the template body in order.
   */
  static async sendTemplate(
    to: string,
    templateName: string,
    bodyParams: string[],
    languageCode = "en"
  ): Promise<boolean> {
    if (!this.isConfigured()) return false;

    const phone = this.formatNumber(to);
    const components =
      bodyParams.length > 0
        ? [
            {
              type: "body",
              parameters: bodyParams.map((text) => ({ type: "text", text })),
            },
          ]
        : [];

    try {
      const res = await fetch(`${GRAPH_URL}/${this.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: templateName,
            language: { code: languageCode },
            components,
          },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        serverLogger.error(
          `[WhatsApp] Template "${templateName}" failed → ${phone}:`,
          err
        );
        return false;
      }
      return true;
    } catch (err: any) {
      serverLogger.error(
        `[WhatsApp] Network error sending "${templateName}" → ${phone}:`,
        err.message
      );
      return false;
    }
  }

  /**
   * Service renewal reminder.
   * Template body params: {{1}} serviceName, {{2}} daysRemaining, {{3}} renewUrl
   */
  static async sendServiceReminder(
    whatsappNumber: string,
    {
      serviceName,
      daysRemaining,
    }: { serviceName: string; daysRemaining: number }
  ): Promise<void> {
    const template =
      process.env.WHATSAPP_TEMPLATE_REMINDER ?? "service_renewal_reminder";
    const renewUrl = `${process.env.NEXTAUTH_URL ?? ""}/dashboard`;
    await this.sendTemplate(whatsappNumber, template, [
      serviceName,
      String(daysRemaining),
      renewUrl,
    ]);
  }

  /**
   * Payment confirmed.
   * Template body params: {{1}} amount+currency, {{2}} serviceName
   */
  static async sendPaymentConfirmed(
    whatsappNumber: string,
    {
      amount,
      currency = "INR",
      serviceName,
    }: { amount: number; currency?: string; serviceName: string }
  ): Promise<void> {
    const template =
      process.env.WHATSAPP_TEMPLATE_PAYMENT ?? "payment_confirmed";
    await this.sendTemplate(whatsappNumber, template, [
      `${currency} ${amount}`,
      serviceName,
    ]);
  }

  /**
   * Service suspended.
   * Template body params: {{1}} serviceName, {{2}} serviceType, {{3}} renewUrl
   */
  static async sendServiceSuspended(
    whatsappNumber: string,
    {
      serviceName,
      serviceType,
    }: { serviceName: string; serviceType: string }
  ): Promise<void> {
    const template =
      process.env.WHATSAPP_TEMPLATE_SUSPENDED ?? "service_suspended";
    const renewUrl = `${process.env.NEXTAUTH_URL ?? ""}/dashboard`;
    await this.sendTemplate(whatsappNumber, template, [
      serviceName,
      serviceType,
      renewUrl,
    ]);
  }
}
