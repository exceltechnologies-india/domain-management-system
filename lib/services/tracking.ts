/**
 * Analytics / marketing-tag tracking service.
 *
 * Design (operator decision 2026-07-07): admins paste the RAW snippet that
 * Google / Meta hand them, and the platform EXTRACTS just the canonical ID
 * from it. We store ONLY the extracted ID — never the pasted script — and the
 * site renders our own vetted official snippet keyed on that ID (see
 * components/TrackingScripts.tsx). This keeps the admin UX familiar ("paste
 * the code") while the site never executes admin-supplied markup: the only
 * thing that runs is a first-party, nonce'd snippet parameterised by a
 * strictly-validated ID. Best of both — easy for admins, safe by construction.
 *
 * Supported providers: Google Analytics 4 (G-…), Google Tag Manager (GTM-…),
 * Meta / Facebook Pixel (numeric), Google Ads (AW-…).
 */

import { getSettingsMap } from "@/lib/services/settings";

export interface TrackingConfig {
  enabled: boolean;
  ga4Id: string;
  gtmId: string;
  metaPixelId: string;
  googleAdsId: string;
  /** Load tags on /admin and /dashboard too. Default false — analytics
   * normally shouldn't count staff/admin sessions. */
  loadOnAdmin: boolean;
}

export type TrackingProvider = "ga4" | "gtm" | "meta" | "googleAds";

export const TRACKING_SETTING_KEYS = {
  enabled: "tracking_enabled",
  ga4Id: "tracking_ga4_id",
  gtmId: "tracking_gtm_id",
  metaPixelId: "tracking_meta_pixel_id",
  googleAdsId: "tracking_google_ads_id",
  loadOnAdmin: "tracking_load_on_admin",
} as const;

/**
 * Extract + validate a provider's canonical ID from either a raw pasted
 * snippet or a bare ID the admin typed directly. Returns the cleaned,
 * canonical-cased ID, or '' when nothing valid is found.
 *
 * This is the security boundary: whatever the admin pastes, only a string
 * matching the strict per-provider shape is ever returned (and therefore
 * ever stored). An attacker who POSTs arbitrary markup to the settings API
 * gets '' back, not their payload.
 */
export function extractTrackingId(
  provider: TrackingProvider,
  raw: string
): string {
  if (!raw || typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s) return "";

  switch (provider) {
    case "ga4": {
      // GA4 Measurement ID: G-XXXXXXXX (letters+digits after the G-).
      const m = s.match(/\bG-[A-Z0-9]{4,15}\b/i);
      return m ? m[0].toUpperCase() : "";
    }
    case "gtm": {
      // GTM container: GTM-XXXXXXX.
      const m = s.match(/\bGTM-[A-Z0-9]{4,15}\b/i);
      return m ? m[0].toUpperCase() : "";
    }
    case "googleAds": {
      // Google Ads conversion: AW-XXXXXXXXX (digits).
      const m = s.match(/\bAW-[0-9]{6,15}\b/i);
      return m ? m[0].toUpperCase() : "";
    }
    case "meta": {
      // Meta Pixel is a bare numeric ID. Prefer the one inside
      // fbq('init', '…') so a snippet containing other numbers (dates,
      // versions) doesn't get mis-parsed; fall back to a bare numeric
      // string the admin typed directly.
      const init = s.match(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,20})['"]/i);
      if (init) return init[1];
      const bare = s.match(/^\d{6,20}$/);
      return bare ? bare[0] : "";
    }
    default:
      return "";
  }
}

// ─── Resolved config (server-side render + admin read) ──────────────────────

// Short module-scope cache so the root layout doesn't hit Mongo on every
// request. 60s TTL: a freshly-saved ID appears within a minute site-wide,
// which is fine for an analytics toggle. Invalidated explicitly on save via
// invalidateTrackingCache() so the admin sees their change immediately when
// they navigate to a customer page.
const TRACKING_CACHE_TTL_MS = 60_000;
let _cache: { config: TrackingConfig; expires: number } | null = null;

export function invalidateTrackingCache(): void {
  _cache = null;
}

const asBool = (v: unknown): boolean => v === true || v === "true";
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Resolve the current tracking configuration from the Settings collection.
 * All values are stored as already-extracted canonical IDs (the write path
 * runs {@link extractTrackingId} before persisting), so this is a plain read.
 */
export async function getTrackingConfig(): Promise<TrackingConfig> {
  const now = Date.now();
  if (_cache && _cache.expires > now) return _cache.config;

  let config: TrackingConfig = {
    enabled: false,
    ga4Id: "",
    gtmId: "",
    metaPixelId: "",
    googleAdsId: "",
    loadOnAdmin: false,
  };

  try {
    const map = await getSettingsMap(Object.values(TRACKING_SETTING_KEYS));
    config = {
      enabled: asBool(map[TRACKING_SETTING_KEYS.enabled]),
      ga4Id: asStr(map[TRACKING_SETTING_KEYS.ga4Id]),
      gtmId: asStr(map[TRACKING_SETTING_KEYS.gtmId]),
      metaPixelId: asStr(map[TRACKING_SETTING_KEYS.metaPixelId]),
      googleAdsId: asStr(map[TRACKING_SETTING_KEYS.googleAdsId]),
      loadOnAdmin: asBool(map[TRACKING_SETTING_KEYS.loadOnAdmin]),
    };
  } catch {
    // Fail closed — no tags rather than a render error. _cache stays null so
    // the next request retries the DB.
    return config;
  }

  _cache = { config, expires: now + TRACKING_CACHE_TTL_MS };
  return config;
}

/** True when tracking is enabled AND at least one provider ID is configured. */
export function hasAnyTag(c: TrackingConfig): boolean {
  return (
    c.enabled &&
    Boolean(c.ga4Id || c.gtmId || c.metaPixelId || c.googleAdsId)
  );
}
