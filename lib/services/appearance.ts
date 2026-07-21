/**
 * Public-site appearance settings (currently: which footer template renders).
 * Backed by the Settings collection, so it rides the existing settings cache.
 * Server-only — never import from Edge middleware.
 */

import { getSettingValue, upsertSetting } from "@/lib/services/settings";

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
