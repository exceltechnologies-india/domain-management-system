/**
 * First-touch marketing attribution — shared client/server helpers.
 * Captured into a cookie on first visit, read server-side at registration.
 */

export const ATTR_COOKIE = "anutech_attr";
export const ANON_COOKIE = "anutech_anon";

export interface Attribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  fbclid?: string;
  landingPage?: string;
  referrer?: string;
  firstVisitAt?: string;
}

export function parseAttributionCookie(raw: string | undefined | null): Attribution | null {
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw);
    const obj = JSON.parse(decoded);
    return obj && typeof obj === "object" ? (obj as Attribution) : null;
  } catch {
    return null;
  }
}
