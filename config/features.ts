/**
 * Feature flags — controlled via environment variables, no redeploy required
 * when using a secrets manager or runtime env injection.
 *
 * Convention: FEATURE_<NAME>=true to enable, absent/false to disable.
 */

export const FEATURES = {
  // Enable bulk domain registration flow
  BULK_REGISTRATION: process.env.FEATURE_BULK_REGISTRATION === "true",

  // Show new TLDs that are in early access
  EARLY_ACCESS_TLDS: process.env.FEATURE_EARLY_ACCESS_TLDS === "true",

  // Enable pricing cache (set to false to force live API calls for debugging)
  PRICING_CACHE: process.env.FEATURE_PRICING_CACHE !== "false",

  // Show the domain privacy-protection upsell during checkout
  PRIVACY_PROTECTION_UPSELL: process.env.FEATURE_PRIVACY_PROTECTION_UPSELL !== "false",

  // Enable Zoho Books invoice integration
  ZOHO_INVOICING: process.env.FEATURE_ZOHO_INVOICING !== "false",

  // Enable DirectAdmin hosting provisioning
  HOSTING_PROVISIONING: process.env.FEATURE_HOSTING_PROVISIONING !== "false",

  // Maintenance mode — returns 503 on all API routes when true
  MAINTENANCE_MODE: process.env.FEATURE_MAINTENANCE_MODE === "true",
} as const;
