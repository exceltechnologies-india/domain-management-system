/**
 * Configuration for automated service lifecycle management.
 */
export const AUTOMATION_CONFIG = {
  /**
   * Days before expiry when reminders should be sent.
   * Default: 30 days, 15 days, 7 days, and 1 day.
   */
  REMINDER_DAYS: process.env.REMINDER_DAYS
    ? JSON.parse(process.env.REMINDER_DAYS)
    : [30, 15, 7, 1],

  /**
   * Hours after a renewal Order is created (status='pending', never
   * completed) before a payment-reminder email fires. Ascending order —
   * the LAST value is the final reminder; after it's sent, the order stops
   * being chased (see app/api/cron/renewal-payment-dunning/route.ts).
   * Default: 24h, 3 days, 7 days.
   */
  RENEWAL_DUNNING_HOURS: process.env.RENEWAL_DUNNING_HOURS
    ? JSON.parse(process.env.RENEWAL_DUNNING_HOURS)
    : [24, 72, 168],

  /**
   * Default grace period in days if not set in DB settings.
   */
  GRACE_PERIOD_DEFAULT: 3,

  /**
   * Whether to allow time simulation via headers/payloads.
   * Recommended: false in production unless specifically needed for QA.
   */
  ENABLE_TIME_SIMULATION: process.env.ENABLE_TIME_SIMULATION === "true" || process.env.NODE_ENV !== "production",
};