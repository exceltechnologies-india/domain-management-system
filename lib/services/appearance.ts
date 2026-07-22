/**
 * Public-site appearance settings (currently: which footer template renders).
 * Backed by the Settings collection, so it rides the existing settings cache.
 * Server-only — never import from Edge middleware.
 */

import { getSettingValue, upsertSetting } from "@/lib/services/settings";
import { COMPANY_WHATSAPP_DIGITS } from "@/config/company";

export type FooterVariant = "classic" | "modern";

export const FOOTER_VARIANT_KEY = "footer_variant";
export const DEFAULT_FOOTER_VARIANT: FooterVariant = "modern";

export async function getFooterVariant(): Promise<FooterVariant> {
  const v = await getSettingValue<string>(FOOTER_VARIANT_KEY, DEFAULT_FOOTER_VARIANT);
  return v === "classic" ? "classic" : "modern";
}

export async function setFooterVariant(variant: FooterVariant, updatedBy = "system"): Promise<void> {
  await upsertSetting(FOOTER_VARIANT_KEY, variant, {
    category: "appearance",
    description: "Which footer template renders on the public site (classic | modern).",
    updatedBy,
  });
}

// ── Homepage design ────────────────────────────────────────────────────────
// 'landing' = the hosting-trial landing (new); 'classic' = the domain-focused
// homepage (old). Whichever is selected renders at '/'.
export type HomeVariant = "landing" | "classic";

export const HOME_VARIANT_KEY = "home_variant";
export const DEFAULT_HOME_VARIANT: HomeVariant = "landing";

export async function getHomeVariant(): Promise<HomeVariant> {
  const v = await getSettingValue<string>(HOME_VARIANT_KEY, DEFAULT_HOME_VARIANT);
  return v === "classic" ? "classic" : "landing";
}

export async function setHomeVariant(variant: HomeVariant, updatedBy = "system"): Promise<void> {
  await upsertSetting(HOME_VARIANT_KEY, variant, {
    category: "appearance",
    description: "Which homepage design renders at / (landing | classic).",
    updatedBy,
  });
}

// ── Support widget ─────────────────────────────────────────────────────────
// 'chatbot' = the AI chat widget (blue bubble); 'whatsapp' = a floating
// WhatsApp button that opens a chat with the company number directly.
export type SupportWidgetVariant = "chatbot" | "whatsapp";

export const SUPPORT_WIDGET_VARIANT_KEY = "support_widget_variant";
export const DEFAULT_SUPPORT_WIDGET_VARIANT: SupportWidgetVariant = "chatbot";
export const SUPPORT_WHATSAPP_NUMBER_KEY = "support_whatsapp_number";

export async function getSupportWidgetVariant(): Promise<SupportWidgetVariant> {
  const v = await getSettingValue<string>(SUPPORT_WIDGET_VARIANT_KEY, DEFAULT_SUPPORT_WIDGET_VARIANT);
  return v === "whatsapp" ? "whatsapp" : "chatbot";
}

export async function setSupportWidgetVariant(variant: SupportWidgetVariant, updatedBy = "system"): Promise<void> {
  await upsertSetting(SUPPORT_WIDGET_VARIANT_KEY, variant, {
    category: "appearance",
    description: "Which support widget renders on the public site (chatbot | whatsapp).",
    updatedBy,
  });
}

/**
 * Company WhatsApp number in international digits only, e.g. "919876543210".
 * Defaults to the company number from config so the WhatsApp widget works
 * out of the box; an admin can override it in Admin → Pages → Appearance.
 */
export async function getSupportWhatsappNumber(): Promise<string> {
  const v = await getSettingValue<string>(SUPPORT_WHATSAPP_NUMBER_KEY, COMPANY_WHATSAPP_DIGITS);
  const digits = typeof v === "string" ? v.replace(/[^0-9]/g, "") : "";
  return digits || COMPANY_WHATSAPP_DIGITS;
}

export async function setSupportWhatsappNumber(num: string, updatedBy = "system"): Promise<void> {
  await upsertSetting(SUPPORT_WHATSAPP_NUMBER_KEY, (num || "").replace(/[^0-9]/g, ""), {
    category: "appearance",
    description: "Company WhatsApp number (digits only) the WhatsApp support widget opens a chat with.",
    updatedBy,
  });
}
