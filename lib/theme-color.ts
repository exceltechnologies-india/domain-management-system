/**
 * Accent colour for third-party widgets (e.g. the Razorpay Checkout overlay)
 * that need a plain hex string and can't use CSS variables.
 *
 * Follows the frontend theme: the root layout stamps <html data-theme="landing">
 * on public frontend pages when the frontend theme is set to violet, so we
 * mirror that here. On the dashboard/admin (no data-theme) or under the Azure
 * theme it returns the brand azure.
 */
export const BRAND_AZURE = "#0177E1";
export const BRAND_VIOLET = "#7C3AED";

export function razorpayThemeColor(): string {
  if (typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "landing") {
    return BRAND_VIOLET;
  }
  return BRAND_AZURE;
}
