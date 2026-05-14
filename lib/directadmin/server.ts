/**
 * DirectAdmin server-level operations (system info, resellers, license).
 */

import axios from 'axios';
import {
  DA_URL,
  DEFAULT_TIMEOUT_MS,
  DirectAdminError,
  executeRequest,
  getAuth,
  parseDAError,
  parseResponseData,
} from './client';

/**
 * Fetches system-wide information including software versions.
 */
export async function getServerInfo(): Promise<any> {
  return executeRequest(
    async () => {
      const response = await axios.get(`${DA_URL}/CMD_API_SYSTEM_INFO`, {
        auth: getAuth(),
        timeout: DEFAULT_TIMEOUT_MS,
      });

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'GetServerInfo', 200, response.data);
      }

      return parseResponseData(response.data);
    },
    'GetServerInfo'
  );
}

/**
 * List all resellers on the DirectAdmin server
 */
export async function listResellers(): Promise<string[]> {
  return executeRequest(
    async () => {
      const response = await axios.get(`${DA_URL}/CMD_API_SHOW_RESELLERS`, {
        auth: getAuth(),
        timeout: DEFAULT_TIMEOUT_MS,
      });

      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'ListResellers', 200, response.data);
      }

      const data = parseResponseData(response.data);
      const rawList = data['list[]'] || data.list || [];
      const resellers = Array.isArray(rawList) ? rawList : [rawList];

      return resellers.filter(Boolean);
    },
    'ListResellers'
  );
}

/**
 * Fetches the current DirectAdmin license information and account counts
 */
export async function getLicenseInfo(): Promise<any> {
  return executeRequest(
    async () => {
      const response = await axios.get(`${DA_URL}/CMD_API_LICENSE`, {
        auth: getAuth(),
        timeout: DEFAULT_TIMEOUT_MS,
      });

      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'GetLicenseInfo', 200, response.data);
      }

      return parseResponseData(response.data);
    },
    'GetLicenseInfo'
  );
}
