/**
 * Accent colour for third-party widgets (e.g. the Razorpay Checkout overlay)
 * that need a plain hex string and can't use CSS variables.
 *
 * Always the ResellerOS storefront blue (site.css --primary). There is no violet
 * frontend theme any more (3 Oct 2026: customers see the ResellerOS brand everywhere).
 */
export const BRAND_BLUE = "#1668E3";

export function razorpayThemeColor(): string {
  return BRAND_BLUE;
}
