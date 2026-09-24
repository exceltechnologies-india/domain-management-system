/**
 * DirectAdmin hosting package operations.
 */

import axios from 'axios';
import { serverLogger } from '@/lib/server-logger';
import {
  ADMIN_USER,
  API_KEY,
  DA_URL,
  DEFAULT_TIMEOUT_MS,
  DirectAdminError,
  executeRequest,
  getAuth,
  normalizePackageName,
  parseDAError,
  parseResponseData,
  validatePackageName,
} from './client';
import { unwrapDAError } from './types';

/**
 * Lists all existing hosting packages available on the DirectAdmin server.
 * These packages can be assigned to new or existing user accounts.
 *
 * @returns {Promise<string[]>} Array of package names
 */
export async function listPackages(): Promise<string[]> {
  return executeRequest(
    async () => {
      // Use CMD_API_PACKAGES_USER as it lists packages created by the admin/reseller
      const response = await axios.get(`${DA_URL}/CMD_API_PACKAGES_USER`, {
        // params: { json: 'yes' }, // Not strictly needed for this endpoint
        auth: getAuth(),
        timeout: DEFAULT_TIMEOUT_MS,
      });

      serverLogger.info(`[ListPackages] Status: ${response.status} Data Type: ${typeof response.data}`);

      // Ensure we didn't get HTML (Login page)
      if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
           throw new Error('DirectAdmin returned HTML (Login Page). Check credentials or IP allowlist.');
      }

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'ListPackages', 200, response.data);
      }

      const data = parseResponseData(response.data) as Record<string, string | string[] | undefined>;
      serverLogger.info('[ListPackages] Raw parsed response:', JSON.stringify(data));

      // DirectAdmin can return packages as list[], list, or packages
      const rawList = data['list[]'] || data.list || data.packages || [];

      // Ensure it's an array
      const packages = Array.isArray(rawList) ? rawList : [rawList];

      // Filter out empty values and return
      return packages.filter(Boolean);
    },
    'ListPackages'
  );
}

/**
 * Fetches detailed configuration for a specific package.
 * Returns object with quota, bandwidth, etc.
 */
export async function getPackageDetails(packageName: string): Promise<Record<string, string | undefined>> {
  packageName = normalizePackageName(packageName);

  return executeRequest(
      async () => {
          const response = await axios.get(`${DA_URL}/CMD_API_PACKAGES_USER`, {
              params: { package: packageName },
              auth: getAuth(),
              timeout: DEFAULT_TIMEOUT_MS,
          });

          if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
              throw new Error('DirectAdmin returned HTML (Login Page).');
          }

          // Check for error response
          if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
               throw new DirectAdminError(parseDAError(response.data), 'GetPackageDetails', 200, response.data);
          }

          return parseResponseData(response.data) as Record<string, string | undefined>;
      },
      `GetPackageDetails-${packageName}`
  );
}

/**
 * Creates a new hosting package with specified resources.
 *
 * @param packageName Name of the package to create
 * @param options Resource limits (quota, bandwidth, mysql, etc.)
 * @returns DirectAdmin API response
 */
export async function createPackage(packageName: string, options: Record<string, string | undefined> = {}) {
  packageName = normalizePackageName(packageName);
  validatePackageName(packageName);

  /**
   * `add: 'Save'`, not `action: 'create'` — measured 24 Sep 2026 against the live
   * DirectAdmin (server1.anutech.in). The old payload was answered
   * "error=1&text=Use these api commands for listing data": without `add`,
   * DirectAdmin reads the call as a LIST request and creates nothing, so the
   * admin "sync default packages" path could never have created one. The same
   * request with `add=Save` and explicit limits returned `text=Saved`.
   *
   * A limit given as "unlimited" (the defaults route passes that string for a
   * plan with no cap) becomes DirectAdmin's own form, `u<limit>=ON`. Limits the
   * caller does not set default to unlimited, except the few below.
   */
  const LIMIT_KEYS = ['bandwidth', 'quota', 'vdomains', 'nsubdomains', 'nemails', 'nemailf', 'nemailml', 'nemailr', 'mysql', 'domainptr', 'ftp', 'inode'] as const;
  const merged: Record<string, string | undefined> = {
    quota: '1000',
    bandwidth: '10000',
    mysql: '5',
    domainptr: '5',
    ftp: '5',
    ...options,
  };
  const payload: Record<string, string> = {
    add: 'Save',
    packagename: packageName,
    language: 'en',
    skin: 'evolution',
    uemail: 'ON',
    cgi: 'ON',
    php: 'ON',
    spam: 'ON',
    cron: 'ON',
    ssl: 'ON',
    dnscontrol: 'ON',
    suspend_at_limit: 'ON',
  };
  for (const key of LIMIT_KEYS) {
    const v = merged[key];
    if (v === undefined || v === 'unlimited') payload[`u${key}`] = 'ON';
    else payload[key] = v;
  }
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && !(LIMIT_KEYS as readonly string[]).includes(k)) payload[k] = v;
  }

  return executeRequest(
    async () => {
      const response = await axios.post(
        `${DA_URL}/CMD_API_MANAGE_USER_PACKAGES`,
        new URLSearchParams(payload).toString(),
        {
          auth: getAuth(),
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'CreatePackage', 200, response.data);
      }

      serverLogger.info(`DirectAdmin: Package created: ${packageName}`, JSON.stringify(response.data));
      return response.data;
    },
    `CreatePackage-${packageName}`
  ).catch((error: unknown) => {
     if (error instanceof DirectAdminError) throw error;

     const u = unwrapDAError(error);
     const errorMessage = (u.data !== undefined ? parseDAError(u.data) : "") || u.message;
     serverLogger.error(`DirectAdmin Package Creation Error (${packageName}):`, errorMessage);
     throw new Error(`Failed to create hosting package: ${errorMessage}`);
  });
}
