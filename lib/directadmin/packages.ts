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

      const data = parseResponseData(response.data);
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
export async function getPackageDetails(packageName: string): Promise<any> {
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

          return parseResponseData(response.data);
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
export async function createPackage(packageName: string, options: any = {}) {
  packageName = normalizePackageName(packageName);
  validatePackageName(packageName);

  const payload = {
    action: 'create',
    packagename: packageName,
    quota: options.quota || '1000',
    bandwidth: options.bandwidth || '10000',
    uemail: 'ON',
    mysql: options.mysql || '5',
    domainptr: options.domainptr || '5',
    ftp: options.ftp || '5',
    cgi: 'ON',
    php: 'ON',
    spam: 'ON',
    ...options,
  };

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
  ).catch((error: any) => {
     if (error instanceof DirectAdminError) throw error;

     const errorMessage = parseDAError(error.response?.data) || error.message;
     serverLogger.error(`DirectAdmin Package Creation Error (${packageName}):`, errorMessage);
     throw new Error(`Failed to create hosting package: ${errorMessage}`);
  });
}
