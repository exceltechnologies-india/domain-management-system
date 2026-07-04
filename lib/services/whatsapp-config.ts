/**
 * WhatsApp configuration resolver.
 *
 * Split-source config (operator decision 2026-07-03):
 *   - The SECRET (`WHATSAPP_API_TOKEN`, a Meta permanent access token) lives
 *     ONLY in Secret Manager / env — never in MongoDB, never in the admin
 *     panel. A developer rotates it. Storing a real bearer token in the DB
 *     would mean a Mongo dump leaks it; keeping it env-only closes that.
 *   - Everything OPERATIONAL (enable toggle, phone-number ID, business
 *     number, template names) is admin-managed via the Settings collection
 *     so the operator can change it without a developer / deploy.
 *
 * Resolution precedence for the operational fields:
 *     admin-panel Settings (DB)  →  env var  →  hardcoded default
 *
 * The token has no DB layer — it's env-only:
 *     process.env.WHATSAPP_API_TOKEN  →  (absent = not configured)
 *
 * `isConfigured()` requires the token (env) AND a phone-number ID AND the
 * master enable flag. All three must be present for a send to fire.
 */

import { getSettingsMap } from "@/lib/services/settings";

// Settings keys — admin-panel-managed. Mirrored in the admin settings UI
// + the SECURITY_KEYS/NEVER_SECURITY_KEYS lists in the settings route
// (these are NEVER_SECURITY — none carry a secret, so no step-up needed).
export const WHATSAPP_SETTING_KEYS = {
  enabled: "whatsapp_enabled",
  phoneNumberId: "whatsapp_phone_number_id",
  businessNumber: "whatsapp_business_number",
  templateReminder: "whatsapp_template_reminder",
  templatePayment: "whatsapp_template_payment",
  templateSuspended: "whatsapp_template_suspended",
  templateWelcome: "whatsapp_template_welcome",
} as const;

// Hardcoded fallback template names — must match what's approved in the
// Meta WhatsApp Manager. Overridable per-environment via env var, and
// per-operator via the admin panel.
const DEFAULT_TEMPLATE_REMINDER = "service_renewal_reminder";
const DEFAULT_TEMPLATE_PAYMENT = "payment_confirmed";
const DEFAULT_TEMPLATE_SUSPENDED = "service_suspended";
const DEFAULT_TEMPLATE_WELCOME = "hosting_provisioned";

export interface WhatsAppConfig {
  /** Master on/off. When false, no WhatsApp message fires regardless of the rest. */
  enabled: boolean;
  /** Meta permanent access token — env-only (Secret Manager in prod). */
  apiToken: string | undefined;
  /** Meta phone-number ID (an identifier, not a secret). */
  phoneNumberId: string | undefined;
  /** Human-readable business number for display in the admin UI (E.164 or raw). */
  businessNumber: string | undefined;
  /** Approved template names. */
  templates: {
    reminder: string;
    payment: string;
    suspended: string;
    welcome: string;
  };
}

/** Coerce a settings value that may be boolean or a "true"/"1"/"yes" string. */
function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "1", "yes", "on"].includes(v.toLowerCase());
  return false;
}

/** Trim + treat empty string as undefined so fallbacks kick in. */
function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Resolve the full WhatsApp config. One batched settings read + env reads.
 * Never throws — a DB blip falls through to env/defaults (the settings
 * service swallows errors internally). Callers should check `enabled` +
 * `isWhatsAppConfigured(config)` before attempting a send.
 */
export async function getWhatsAppConfig(): Promise<WhatsAppConfig> {
  const settings = await getSettingsMap(Object.values(WHATSAPP_SETTING_KEYS));

  // enable flag: DB → env (WHATSAPP_ENABLED) → default false. Default OFF
  // so the feature is strictly opt-in even if a token happens to be set.
  const enabledSetting = settings[WHATSAPP_SETTING_KEYS.enabled];
  const enabled =
    enabledSetting !== undefined
      ? toBool(enabledSetting)
      : toBool(process.env.WHATSAPP_ENABLED);

  return {
    enabled,
    // Token: env ONLY. No DB layer by design.
    apiToken: clean(process.env.WHATSAPP_API_TOKEN),
    phoneNumberId:
      clean(settings[WHATSAPP_SETTING_KEYS.phoneNumberId]) ??
      clean(process.env.WHATSAPP_PHONE_NUMBER_ID),
    businessNumber: clean(settings[WHATSAPP_SETTING_KEYS.businessNumber]),
    templates: {
      reminder:
        clean(settings[WHATSAPP_SETTING_KEYS.templateReminder]) ??
        clean(process.env.WHATSAPP_TEMPLATE_REMINDER) ??
        DEFAULT_TEMPLATE_REMINDER,
      payment:
        clean(settings[WHATSAPP_SETTING_KEYS.templatePayment]) ??
        clean(process.env.WHATSAPP_TEMPLATE_PAYMENT) ??
        DEFAULT_TEMPLATE_PAYMENT,
      suspended:
        clean(settings[WHATSAPP_SETTING_KEYS.templateSuspended]) ??
        clean(process.env.WHATSAPP_TEMPLATE_SUSPENDED) ??
        DEFAULT_TEMPLATE_SUSPENDED,
      welcome:
        clean(settings[WHATSAPP_SETTING_KEYS.templateWelcome]) ??
        clean(process.env.WHATSAPP_TEMPLATE_WELCOME) ??
        DEFAULT_TEMPLATE_WELCOME,
    },
  };
}

/**
 * A config is send-ready when the master flag is on AND both the env-only
 * token and the phone-number ID are present. Templates always have a
 * default so they don't gate readiness.
 */
export function isWhatsAppConfigured(config: WhatsAppConfig): boolean {
  return config.enabled && !!config.apiToken && !!config.phoneNumberId;
}
