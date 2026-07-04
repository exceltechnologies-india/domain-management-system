import { serverLogger } from "@/lib/server-logger";
import {
  getWhatsAppConfig,
  isWhatsAppConfigured,
  type WhatsAppConfig,
} from "@/lib/services/whatsapp-config";

const GRAPH_URL = "https://graph.facebook.com/v18.0";

/**
 * WhatsApp Cloud API (Meta) — sends pre-approved template messages.
 *
 * Config is split-source (see lib/services/whatsapp-config.ts):
 *   - SECRET token: env / Secret Manager only (`WHATSAPP_API_TOKEN`).
 *   - Operational config (enable flag, phone-number ID, template names,
 *     business number): admin-panel-managed via Settings, env-fallback.
 *
 * Every send resolves the config fresh, gates on
 * `isWhatsAppConfigured` (enabled + token + phone-number ID), and is
 * best-effort — network / API errors are logged and swallowed, never
 * thrown, because notification sends run inside worker hot paths and
 * must not stall or fail the surrounding request.
 */
export class WhatsAppService {
  /**
   * Resolve config-readiness. Async now (was a sync env check) because
   * the operational config lives in the DB. Kept as a named method so
   * call sites that want to pre-check before composing a message can.
   */
  static async isConfigured(): Promise<boolean> {
    const config = await getWhatsAppConfig();
    return isWhatsAppConfigured(config);
  }

  /** Normalise to E.164 format, assuming India (+91) for 10-digit numbers. */
  static formatNumber(raw: string): string {
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
    if (digits.length === 10) return `+91${digits}`;
    return `+${digits}`;
  }

  /**
   * Actual send against a pre-resolved config. Private so convenience
   * methods + the public sendTemplate share one config resolution per
   * public call (no double DB read).
   */
  private static async dispatch(
    config: WhatsAppConfig,
    to: string,
    templateName: string,
    bodyParams: string[],
    languageCode: string
  ): Promise<boolean> {
    if (!isWhatsAppConfigured(config)) return false;

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
      // 15s upper bound — runs inside worker hot paths
      // (`process-service-expiry`). A hung Graph slot must not stall the
      // worker's Cloud Run slot.
      const res = await fetch(`${GRAPH_URL}/${config.phoneNumberId}/messages`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      serverLogger.error(
        `[WhatsApp] Network error sending "${templateName}" → ${phone}:`,
        message
      );
      return false;
    }
  }

  /**
   * Send a template message. Body parameters are substituted into {{1}}, {{2}}, …
   * in the template body in order. Resolves the split-source config
   * internally + gates on it — returns false (no send) when WhatsApp is
   * disabled or unconfigured.
   */
  static async sendTemplate(
    to: string,
    templateName: string,
    bodyParams: string[],
    languageCode = "en"
  ): Promise<boolean> {
    const config = await getWhatsAppConfig();
    return this.dispatch(config, to, templateName, bodyParams, languageCode);
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
    const config = await getWhatsAppConfig();
    const renewUrl = `${process.env.NEXTAUTH_URL ?? ""}/dashboard`;
    await this.dispatch(config, whatsappNumber, config.templates.reminder, [
      serviceName,
      String(daysRemaining),
      renewUrl,
    ], "en");
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
    const config = await getWhatsAppConfig();
    await this.dispatch(config, whatsappNumber, config.templates.payment, [
      `${currency} ${amount}`,
      serviceName,
    ], "en");
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
    const config = await getWhatsAppConfig();
    const renewUrl = `${process.env.NEXTAUTH_URL ?? ""}/dashboard`;
    await this.dispatch(config, whatsappNumber, config.templates.suspended, [
      serviceName,
      serviceType,
      renewUrl,
    ], "en");
  }
}
