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

// ── Frontend theme ─────────────────────────────────────────────────────────
// 'violet' = the landing's violet scheme; 'azure' = the classic Anutech blue.
// Applied to public frontend paths only (not /dashboard, /admin) via
// <html data-theme="landing">. Independent toggle so the theme can be shifted
// alongside (or separately from) the homepage variant.
export type FrontendTheme = "azure" | "violet";

export const FRONTEND_THEME_KEY = "frontend_theme";
export const DEFAULT_FRONTEND_THEME: FrontendTheme = "violet";

export async function getFrontendTheme(): Promise<FrontendTheme> {
  const v = await getSettingValue<string>(FRONTEND_THEME_KEY, DEFAULT_FRONTEND_THEME);
  return v === "azure" ? "azure" : "violet";
}

export async function setFrontendTheme(theme: FrontendTheme, updatedBy = "system"): Promise<void> {
  await upsertSetting(FRONTEND_THEME_KEY, theme, {
    category: "appearance",
    description: "Public frontend colour scheme (azure | violet).",
    updatedBy,
  });
}

// ── Contact detail visibility ──────────────────────────────────────────────
// Operator toggles for whether the public GSTIN (footer) and phone number
// ("Call Us" card) are shown. Default: shown.
export const SHOW_GSTIN_KEY = "show_gstin";
export const SHOW_PHONE_KEY = "show_phone";

function coerceBool(v: unknown, fallback: boolean): boolean {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return fallback;
}

export async function getShowGstin(): Promise<boolean> {
  return coerceBool(await getSettingValue<unknown>(SHOW_GSTIN_KEY, true), true);
}

export async function setShowGstin(show: boolean, updatedBy = "system"): Promise<void> {
  await upsertSetting(SHOW_GSTIN_KEY, show, {
    category: "appearance",
    description: "Whether the public GSTIN is shown in the footer.",
    updatedBy,
  });
}

export async function getShowPhone(): Promise<boolean> {
  return coerceBool(await getSettingValue<unknown>(SHOW_PHONE_KEY, true), true);
}

export async function setShowPhone(show: boolean, updatedBy = "system"): Promise<void> {
  await upsertSetting(SHOW_PHONE_KEY, show, {
    category: "appearance",
    description: "Whether the company phone number is shown publicly (Call Us card).",
    updatedBy,
  });
}

// ── Social links ───────────────────────────────────────────────────────────
// Admin-editable social profile URLs + per-platform show/hide. Only these
// three platforms are supported (footer shows the enabled ones).
export type SocialPlatform = "linkedin" | "facebook" | "instagram";
export interface SocialLink { url: string; enabled: boolean; }
export type SocialLinks = Record<SocialPlatform, SocialLink>;

export const SOCIAL_LINKS_KEY = "social_links";

export const DEFAULT_SOCIAL_LINKS: SocialLinks = {
  linkedin: { url: "https://www.linkedin.com/company/anutech-digital-pvt-ltd/", enabled: true },
  facebook: { url: "https://www.facebook.com/profile.php?id=61568334534264", enabled: true },
  instagram: { url: "https://www.instagram.com/anutech_digital/", enabled: true },
};

const SOCIAL_PLATFORMS: SocialPlatform[] = ["linkedin", "facebook", "instagram"];

export async function getSocialLinks(): Promise<SocialLinks> {
  const raw = await getSettingValue<Partial<SocialLinks>>(SOCIAL_LINKS_KEY, DEFAULT_SOCIAL_LINKS);
  const out = {} as SocialLinks;
  for (const p of SOCIAL_PLATFORMS) {
    const v = raw && typeof raw === "object" ? (raw as Partial<SocialLinks>)[p] : undefined;
    out[p] = {
      url: typeof v?.url === "string" ? v.url : DEFAULT_SOCIAL_LINKS[p].url,
      enabled: v?.enabled === false ? false : true,
    };
  }
  return out;
}

export async function setSocialLinks(links: Partial<Record<SocialPlatform, Partial<SocialLink>>>, updatedBy = "system"): Promise<void> {
  const current = await getSocialLinks();
  const merged = {} as SocialLinks;
  for (const p of SOCIAL_PLATFORMS) {
    merged[p] = {
      url: typeof links?.[p]?.url === "string" ? links[p]!.url.trim() : current[p].url,
      enabled: typeof links?.[p]?.enabled === "boolean" ? links[p]!.enabled : current[p].enabled,
    };
  }
  await upsertSetting(SOCIAL_LINKS_KEY, merged, {
    category: "appearance",
    description: "Social profile URLs + per-platform visibility (linkedin/facebook/instagram).",
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
