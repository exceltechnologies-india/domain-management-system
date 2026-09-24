/**
 * DMS does not open Razorpay Subscriptions for hosting — unless someone
 * deliberately turns them back on with DMS_HOSTING_SUBSCRIPTIONS_ENABLED=1.
 *
 * Two owner decisions of 24 Sep 2026 meet here:
 *   - "Renewals subscription will be handled by ResellerOS. Period."
 *   - "ResellerOS is correct price one. Use that." — ResellerOS's rate plus
 *     18% GST (lib/pricing/hosting-price.ts).
 *
 * A DMS subscription cannot carry that price. Its Razorpay plans are created
 * by `api/admin/hosting/packages` as `renewalPrice` (monthly) and
 * `renewalPrice × 12` (yearly), i.e. yearly = 12 × monthly — while ResellerOS
 * charges a year at 6 × its monthly-billing rate (₹600 vs ₹100/month for
 * Starter). And a subscription is a DMS-collected renewal, which decision 4
 * gave to ResellerOS. So paid hosting bought in the panel is one payment for
 * its period, and a trial goes through the no-mandate flow, whose conversion
 * is paid through `api/user/hosting/renew` at the ResellerOS price.
 *
 * Same posture as the tokens charger (DMS_TOKEN_RECURRING_ENABLED): the code
 * is kept, off by default, and only an exact "1" turns it on — an empty or
 * misspelled value keeps it off (AGENTS.md L41). Re-enabling it without new
 * Razorpay plans at ResellerOS's prices would charge the old DMS figure.
 */
export function dmsCreatesHostingSubscriptions(): boolean {
  return process.env.DMS_HOSTING_SUBSCRIPTIONS_ENABLED === "1";
}
