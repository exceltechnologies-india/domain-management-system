/**
 * DirectAdmin client
 *
 * Shared module-level state, request executor, rate limiting, and
 * circuit breaker for all directadmin submodules.
 */

import { serverLogger } from '@/lib/server-logger';
import { HOSTING_PLANS } from '@/config/hosting-plans';
import type { DAErrorPayload, DAParsedResponse } from './types';
import { unwrapDAError } from './types';

export const DA_URL = process.env.DIRECTADMIN_URL;
export const ADMIN_USER = process.env.DIRECTADMIN_ADMIN_USER;
export const API_KEY = process.env.DIRECTADMIN_API_KEY;

/**
 * The shared-server IP that DA accounts get bound to. Sourced from the
 * DIRECTADMIN_IP env var; the literal fallback is the current production
 * server's IP (kept so local-dev / first-boot smoke tests don't crash before
 * the env is wired). Production deploys MUST set DIRECTADMIN_IP — a
 * forgotten env in staging would otherwise silently provision new hosting
 * accounts onto the prod DA box.
 *
 * Updated 2026-06-22 from the old `136.115.64.54` fallback (the previous
 * server that's being retired) to `35.208.86.44`. The senior reviewer hit
 * this immediately after the DA server switch — every create-user call was
 * failing with "That IP does not exist in your list" because DIRECTADMIN_IP
 * was never in the deploy script's ENV_VARS list, so Cloud Run ran with the
 * stale fallback.
 *
 * Updated 2026-07-27 to `34.93.167.160` — the panel moved again to
 * server1.anutech.in (DIRECTADMIN_URL) and `35.208.86.44` (the previous
 * box) is no longer in server1's IP Manager, so trial DA provisioning was
 * hard-failing with the exact same "That IP does not exist in your list"
 * error. `34.93.167.160` is server1.anutech.in's primary IP. DIRECTADMIN_IP
 * is now in the deploy script's ENV_VARS, so the .env.local value is the
 * source of truth; this literal is only the local-dev / missing-env fallback.
 */
const DA_FALLBACK_IP = "34.93.167.160";
export const DA_SERVER_IP =
  process.env.DIRECTADMIN_IP ||
  (process.env.NODE_ENV === "production"
    ? (() => {
        // eslint-disable-next-line no-console
        console.error(
          "[directadmin] DIRECTADMIN_IP env var missing in production — falling back to literal. Fix the deploy config."
        );
        return DA_FALLBACK_IP;
      })()
    : DA_FALLBACK_IP);

/**
 * DirectAdmin Service
 * Handles API interactions with the DirectAdmin control panel.
 *
 * PROTECTION FEATURES:
 * - Rate limiting: Minimum 2 second delay between requests
 * - Fail-fast credential validation
 * - Retry logic with exponential backoff (network errors only)
 * - Request queue to prevent concurrent requests
 */

export class DirectAdminError extends Error {
  public readonly status?: number;
  public readonly response?: unknown;
  public readonly context?: string;

  constructor(message: string, context?: string, status?: number, response?: unknown) {
    super(message);
    this.name = 'DirectAdminError';
    this.context = context;
    this.status = status;
    this.response = response;
  }
}

// Nameservers assigned/displayed for new hosting accounts on server1.anutech.in
// (OrderBox/ResellerClub DNS). Stored on the Hosting record + shown to the
// customer; DA account creation itself uses the server default.
export const NAMESERVERS = [
  "deepak1299294.mercury.orderbox-dns.com",
  "deepak1299294.venus.orderbox-dns.com",
  "deepak1299294.earth.orderbox-dns.com",
  "deepak1299294.mars.orderbox-dns.com",
];

export const KNOWN_PACKAGES = Object.values(HOSTING_PLANS).map(p => p.serverPackage);

// Rate limiting: Track last request time
let lastRequestTime = 0;
export const MIN_REQUEST_INTERVAL_MS = 500;
export const DEFAULT_TIMEOUT_MS = 8000;

// Circuit breaker: open after 5 consecutive failures, reset after 60s
let circuitFailures = 0;
let circuitOpenUntil = 0;
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 60_000;

// Slow-request threshold
const SLOW_REQUEST_MS = 2000;

// Request queue to serialize all DA requests
let requestQueue: Promise<unknown> = Promise.resolve();

export function getAuth() {
  if (!ADMIN_USER || !API_KEY) {
    serverLogger.error('DirectAdmin credentials missing.');
    throw new Error('DirectAdmin credentials (ADMIN_USER or API_KEY) are missing in environment variables.');
  }
  return {
    username: ADMIN_USER as string,
    password: API_KEY as string,
  };
}

export function logDebugCredentials() {
  const user = ADMIN_USER || 'undefined';
  const key = API_KEY || 'undefined';
  serverLogger.info(`[DA-DEBUG] Configured User: ${user.substring(0, 2)}***, Key Length: ${key.length}`);
}

/**
 * Validate credentials format before making any network request
 * This prevents triggering 401/403 errors that could lead to IP blacklisting
 */
function validateCredentials(): void {
  if (!DA_URL) {
    throw new Error('DIRECTADMIN_URL is missing in environment variables.');
  }
  if (!ADMIN_USER || ADMIN_USER.trim().length === 0) {
    throw new Error('DIRECTADMIN_ADMIN_USER is missing or empty.');
  }
  if (!API_KEY || API_KEY.trim().length === 0) {
    throw new Error('DIRECTADMIN_API_KEY is missing or empty.');
  }
}

/**
 * Enforce rate limiting by waiting if needed
 */
async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    const waitTime = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
    serverLogger.info(`[DA-RATE-LIMIT] Waiting ${waitTime}ms before next request`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  lastRequestTime = Date.now();
}

/**
 * Helper to parse DirectAdmin error responses which can be:
 * 1. URL-encoded string (error=1&text=...)
 * 2. HTML (often just the error text wrapped in tags)
 * 3. JSON (in newer APIs)
 */
export function parseDAError(data: unknown): string {
  if (!data) return "Unknown DirectAdmin error";

  // If it's an object with error field
  if (typeof data === 'object' && data !== null) {
    const d = data as DAErrorPayload;
    if (d.error && typeof d.error === 'string') return d.error;
    if (d.text && typeof d.text === 'string') return d.text;
    if (d.details && typeof d.details === 'string') return d.details;
  }

  // If it's a string, try to parse it
  if (typeof data === 'string') {
    // Check for URL encoded style
    if (data.includes('error=1') || data.includes('text=') || data.includes('details=')) {
      const params = new URLSearchParams(data);
      const text = params.get('text');
      const details = params.get('details');
      if (text || details) {
          const combined = [text, details].filter(Boolean).map(s => decodeURIComponent(s || '').replace(/\+/g, ' ')).join(' - ');
          return combined;
      }
    }

    // Check for HTML (basic stripping)
    if (data.includes('<') && data.includes('>')) {
      const textOnly = data.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (textOnly.length > 0 && textOnly.length < 500) return textOnly;
    }

    // Return raw string if short enough
    if (data.length < 500) return data;
  }

  return "Complex or empty error response from DirectAdmin";
}

/**
 * Helper to parse URL-encoded response data from DirectAdmin into a JSON object.
 * DA often returns data like: key1=value1&key2=value2 or list[]=val1&list[]=val2
 */
export function parseResponseData(data: unknown): DAParsedResponse {
  if (typeof data !== 'string') return data as DAParsedResponse;

  // If it looks like URL encoded string
  if (data.includes('=')) {
      const result: { [k: string]: string | string[] } = {};
      const params = new URLSearchParams(data);

      params.forEach((value, key) => {
          // If key already exists, convert to array or push to array
          if (result[key] !== undefined) {
              if (Array.isArray(result[key])) {
                  (result[key] as string[]).push(value);
              } else {
                  result[key] = [result[key] as string, value];
              }
          } else {
              result[key] = value;
          }
      });
      return result;
  }

  return data;
}

/**
 * Validate DirectAdmin Username
 * Rules: Alphanumeric, 3-14 characters, no spaces, starts with letter
 */
export function validateUsername(username: string): void {
  if (!username) throw new Error("Username is required");
  if (username.length < 3 || username.length > 16) {
    throw new Error(`Invalid username length (${username.length}). Must be 3-16 characters.`);
  }
  if (!/^[a-z][a-z0-9]*$/.test(username.toLowerCase())) {
      throw new Error("Invalid username format. Must start with a letter and contain only alphanumeric characters.");
  }
}

/**
 * Normalizes package name casing against known packages.
 * "standard" -> "Standard"
 * "unknown_pkg" -> "unknown_pkg"
 */
export function normalizePackageName(packageName: string): string {
  if (!packageName) return packageName;

  const lowerInput = packageName.toLowerCase();
  const found = KNOWN_PACKAGES.find(p => p.toLowerCase() === lowerInput);

  if (found) {
      if (found !== packageName) {
           serverLogger.info(`[DA-NORMALIZE] Corrected package name case: '${packageName}' -> '${found}'`);
      }
      return found;
  }
  return packageName;
}

/**
 * Validate Package Name
 * Rules: Alphanumeric, underscores, dashes
 */
export function validatePackageName(packageName: string): void {
  if (!packageName) throw new Error("Package name is required");
  if (!/^[a-zA-Z0-9_\-]+$/.test(packageName)) {
    throw new Error("Invalid package name. Use only letters, numbers, underscores, and dashes.");
  }
}

/**
 * Centralized request executor with protection features
 * - Validates credentials before making request
 * - Enforces rate limiting
 * - Retries on network errors (NOT on auth errors)
 * - Serializes all requests through a queue
 */
export async function executeRequest<T>(
  requestFn: () => Promise<T>,
  operation: string,
  maxRetries: number = 2
): Promise<T> {
  // Validate credentials first (fail-fast)
  validateCredentials();
  logDebugCredentials(); // Helpful for debugging auth issues

  // When the lockout window expires, reset failure state so a single transient
  // post-recovery error doesn't instantly re-trip the breaker. Without this,
  // circuitFailures stays at its prior (>=threshold) value and the next failed
  // attempt re-opens immediately, trapping the breaker indefinitely.
  if (circuitOpenUntil > 0 && Date.now() >= circuitOpenUntil) {
    circuitFailures = 0;
    circuitOpenUntil = 0;
  }

  // Circuit breaker: reject immediately if open
  if (Date.now() < circuitOpenUntil) {
    const remainingSec = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
    throw new DirectAdminError(
      `Circuit breaker open — DirectAdmin requests paused for ${remainingSec}s after repeated failures`,
      operation, 503
    );
  }

  // Queue this request to ensure serialization
  return new Promise((resolve, reject) => {
    requestQueue = requestQueue.then(async () => {
      let lastError: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          // Enforce rate limiting before each attempt
          await enforceRateLimit();

          serverLogger.info(`[DA-REQUEST] ${operation} (attempt ${attempt + 1}/${maxRetries + 1})`);
          const requestStart = Date.now();
          const result = await requestFn();
          const elapsed = Date.now() - requestStart;
          if (elapsed > SLOW_REQUEST_MS) {
            serverLogger.warn(`[DA-SLOW] ${operation} took ${elapsed}ms`);
          }

          // Global check: If result is a string resembling HTML, it's likely a login page intercepting the API call
          if (typeof result === 'string' && (result.includes('<!DOCTYPE html>') || result.includes('<html'))) {
               // Try to get the final URL to see if it redirected
               const finalUrl = (result as { config?: { url?: string } })?.config?.url || 'unknown';
               const errorMsg = `DirectAdmin returned HTML (Login Page) from ${finalUrl}. Check credentials, IP allowlist, or if 2FA is enabled.`;

               serverLogger.error(`[DA-FAIL] ${operation}: ${errorMsg}`);
               // Do not retry.
               throw new DirectAdminError(errorMsg, operation, 401, { error: 'Auth/IP restriction detected (Login Page returned)' });
          }

          serverLogger.info(`[DA-REQUEST] ${operation} succeeded`);
          // Reset circuit breaker on success
          circuitFailures = 0;
          resolve(result);
          return;
        } catch (error) {
          lastError = error;
          const unwrapped = unwrapDAError(error);
          const status = unwrapped.status;

          // NEVER retry on authentication errors (401/403) - fail immediately
          if (status === 401 || status === 403) {
            const daErrorMessage = parseDAError(unwrapped.data) || 'Authentication failed';
            serverLogger.error(`[DA-REQUEST] ${operation} failed with auth error (${status}). Stopping immediately.`);
            reject(new DirectAdminError(daErrorMessage, operation, status, unwrapped.data));
            return;
          }

          if (error instanceof DirectAdminError) {
             serverLogger.error(`[DA-FAIL] ${operation} failed: ${error.message}`, {
                 status: error.status,
                 response: error.response
             });
             reject(error);
             return;
          }

          // Only retry on network/timeout errors (and not logical DA errors)
          if (attempt < maxRetries && (!status || status >= 500)) {
            const backoffMs = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
            serverLogger.warn(`[DA-REQUEST] ${operation} failed (attempt ${attempt + 1}), retrying in ${backoffMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue; // Retry
          } else {
            // Check for connection specific errors
            const code = unwrapped.code;
            const isConnectionError = code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' || code === 'ENOTFOUND';

            if (isConnectionError || status === 502 || status === 503 || status === 504) {
               let msg = "DirectAdmin server is currently unreachable";

               if (code === 'ECONNREFUSED') {
                  msg = "Connection Refused: DirectAdmin server is up but port 2222 is closed or service is down.";
               } else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
                  msg = "Connection Timed Out: DirectAdmin server is unreachable. Check firewall (port 2222) and IP whitelist.";
               } else if (code === 'ENOTFOUND') {
                  msg = "DNS Lookup Failed: DirectAdmin hostname does not resolve.";
               }

               serverLogger.error(`[DA-FAIL] ${operation} Connection Failed: ${unwrapped.message} (${code})`);
               circuitFailures += 1;
               if (circuitFailures >= CIRCUIT_THRESHOLD) {
                 circuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
                 serverLogger.error(`[DA-CIRCUIT] Circuit breaker opened after ${circuitFailures} failures — pausing for ${CIRCUIT_RESET_MS / 1000}s`);
               }
               reject(new DirectAdminError(msg, operation, 503, { error: msg, code: code || 'DA_SERVER_DOWN' }));
               return;
            }

            // Final fallback if loop exits naturally (should generally not reach here due to reject/resolve/return)
            const daErrorMessage = parseDAError(unwrapped.data) || unwrapped.message;
            const requestUrl = error instanceof Error && 'config' in error
              ? (error as Error & { config?: { url?: string } }).config?.url
              : undefined;
            serverLogger.error(`[DA-FAIL] ${operation} failed permanently after attempts: ${unwrapped.message}`, {
                message: daErrorMessage,
                status: status,
                requestUrl,
                response: unwrapped.data
            });
            circuitFailures += 1;
            if (circuitFailures >= CIRCUIT_THRESHOLD) {
              circuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
              serverLogger.error(`[DA-CIRCUIT] Circuit breaker opened after ${circuitFailures} failures — pausing for ${CIRCUIT_RESET_MS / 1000}s`);
            }
            reject(new DirectAdminError(daErrorMessage, operation, status, unwrapped.data));
            return;
          }
          }
        }
    }).catch(reject);
  });
}
