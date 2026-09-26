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

  // RENEWAL_DUNNING_HOURS was removed on 26 Sep 2026 with
  // cron/renewal-payment-dunning (owner: "Switch it off") — old DMS renewal
  // orders can no longer be paid in DMS, so there is nothing to chase.

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