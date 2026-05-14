/**
 * Centralised API limits, timeouts, and retry configuration.
 * Override any value via environment variables for per-environment tuning.
 */

export const API_LIMITS = {
  // ResellerClub
  RESELLERCLUB_TIMEOUT_MS: parseInt(process.env.RESELLERCLUB_TIMEOUT_MS || "30000"),
  RESELLERCLUB_MAX_RETRIES: parseInt(process.env.RESELLERCLUB_MAX_RETRIES || "2"),

  // DirectAdmin
  DIRECTADMIN_TIMEOUT_MS: parseInt(process.env.DIRECTADMIN_TIMEOUT_MS || "8000"),
  DIRECTADMIN_MAX_RETRIES: parseInt(process.env.DIRECTADMIN_MAX_RETRIES || "2"),
  DIRECTADMIN_MIN_INTERVAL_MS: parseInt(process.env.DIRECTADMIN_MIN_INTERVAL_MS || "500"),
  DIRECTADMIN_CIRCUIT_THRESHOLD: parseInt(process.env.DIRECTADMIN_CIRCUIT_THRESHOLD || "5"),
  DIRECTADMIN_CIRCUIT_RESET_MS: parseInt(process.env.DIRECTADMIN_CIRCUIT_RESET_MS || "60000"),
  DIRECTADMIN_SLOW_REQUEST_MS: parseInt(process.env.DIRECTADMIN_SLOW_REQUEST_MS || "2000"),

  // Pricing cache
  PRICING_CACHE_TTL_S: parseInt(process.env.PRICING_CACHE_TTL_S || "1800"), // 30 min

  // Cart
  CART_SYNC_DEBOUNCE_MS: parseInt(process.env.CART_SYNC_DEBOUNCE_MS || "500"),

  // Rate limiting (requests per window)
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "60"),

  // Pagination defaults
  DEFAULT_PAGE_LIMIT: parseInt(process.env.DEFAULT_PAGE_LIMIT || "20"),
  MAX_PAGE_LIMIT: parseInt(process.env.MAX_PAGE_LIMIT || "100"),
};
