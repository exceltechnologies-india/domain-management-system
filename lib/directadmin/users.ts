/**
 * DirectAdmin user account operations.
 */

import axios from 'axios';
import { serverLogger } from '@/lib/server-logger';
import {
  ADMIN_USER,
  API_KEY,
  DA_SERVER_IP,
  DA_URL,
  DEFAULT_TIMEOUT_MS,
  DirectAdminError,
  executeRequest,
  getAuth,
  normalizePackageName,
  parseDAError,
  parseResponseData,
  validatePackageName,
  validateUsername,
} from './client';
import { unwrapDAError } from './types';

/**
 * Generates a one-time login URL for a specific user.
 * This is used for passwordless SSO (Single Sign-On) from our portal to DirectAdmin.
 *
 * @param username The DirectAdmin username to log in as
 * @param redirectUrl The DirectAdmin command/page to redirect to after login (default: 'CMD_USER_STATS')
 * @returns A one-time URL that logs the user into DirectAdmin
 * @throws {Error} If SSO link generation fails
 */
export async function getOneTimeLoginUrl(username: string, redirectUrl: string = 'CMD_USER_STATS'): Promise<string> {
  validateUsername(username);

  // For SSO, we MUST use the "Login-As" authentication syntax (admin|username)
  // to ensure DirectAdmin generates a session for the target user context,
  // otherwise it may default to the key owner's (admin) context.
  const useAuth = username === ADMIN_USER
    ? getAuth()
    : { username: `${ADMIN_USER}|${username}`, password: API_KEY as string };

  return executeRequest(
    async () => {
      const response = await axios.post(
        `${DA_URL}/CMD_API_LOGIN_KEYS`,
        new URLSearchParams({
          action: 'create',
          type: 'one_time_url',
          user: username,
          'redirect-url': redirectUrl,
          notify: 'no',
          'select_deny0': 'CMD_USER_PASSWD',
          'select_deny1': 'CMD_LOGIN_KEYS',
          'select_deny2': 'CMD_API_LOGIN_KEYS',
          'select_deny3': 'CMD_CHANGE_INFO',
          'select_deny4': 'CMD_TWO_FACTOR_AUTH',
          'allow_html': 'yes',
          max_uses: '1',
          clear_key: 'yes',
          expiry_timestamp: String(Math.floor(Date.now() / 1000) + 3600), // 1 hour
        }).toString(),
          {
            auth: useAuth,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: DEFAULT_TIMEOUT_MS,
          }
      );

      // DirectAdmin returns the raw URL in the response body for this specific type, OR a JSON object with 'result'
      if (response.data && typeof response.data === 'string' && response.data.startsWith('http')) {
        serverLogger.info(`Generated SSO link for user: ${username}`);
        return response.data;
      }

      // Handle JSON response format (e.g. from newer DA versions or specific user types)
      if (response.data && response.data.result && typeof response.data.result === 'string' && response.data.result.startsWith('http')) {
        serverLogger.info(`Generated SSO link for user: ${username} (JSON format)`);
        return response.data.result;
      }

      serverLogger.error(`DirectAdmin SSO: Unexpected response for ${username}:`, response.data);
      throw new Error(`Unexpected response from DirectAdmin: ${typeof response.data === 'object' ? JSON.stringify(response.data) : response.data}`);
    },
    `SSO-LoginURL-${username}`
  ).catch((error: unknown) => {
    const unwrapped = unwrapDAError(error);
    // Don't re-wrap if it's already our improved error
    if (unwrapped.message.startsWith("DirectAdmin authentication failed")) throw error;

    const parsedError = parseDAError(unwrapped.data);

    serverLogger.error(`DirectAdmin SSO Error for ${username}: ${parsedError}`);
    throw new Error(`Failed to generate DirectAdmin SSO link: ${parsedError}`);
  });
}

/**
 * Creates a new DirectAdmin user account and assigns a hosting package.
 *
 * @param username Desired username for the account
 * @param email User's email address
 * @param domain Primary domain to associate with the account
 * @param packageName The hosting package name to assign
 * @param ip The IP address to assign (default: `DA_SERVER_IP` from client.ts)
 * @returns DirectAdmin API response
 */
export async function createUser(username: string, email: string, domain: string, packageName: string, ip: string = DA_SERVER_IP) {
  validateUsername(username);
  packageName = normalizePackageName(packageName);
  validatePackageName(packageName);

  const payload = {
    action: 'create',
    add: 'Submit',
    username,
    email,
    passwd: Math.random().toString(36).slice(-10) + 'A1!', // Temporary password, user will use SSO
    passwd2: '',
    domain,
    package: packageName,
    ip: ip,
    notify: 'no'
  };
  payload.passwd2 = payload.passwd;

  return executeRequest(
    async () => {
      const response = await axios.post(
        `${DA_URL}/CMD_API_ACCOUNT_USER`,
        new URLSearchParams(payload).toString(),
        {
          auth: getAuth(),
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'CreateUser', 200, response.data);
      }

      serverLogger.info(`DirectAdmin: User created: ${username} for domain: ${domain}`);
      return response.data;
    },
    `CreateUser-${username}`
  ).catch((error: unknown) => {
    if (error instanceof DirectAdminError) throw error;

    const u = unwrapDAError(error);
    const errorMessage = parseDAError(u.data) || u.message;
    serverLogger.error(`DirectAdmin User Creation Error (${username}):`, errorMessage);

    // Provide user-friendly errors for common scenarios
    if (errorMessage.toLowerCase().includes("already exists")) {
        throw new Error(`User or domain already exists on the server.`);
    }

    throw new Error(`Failed to create DirectAdmin user: ${errorMessage}`);
  });
}

/**
 * Fetches user configuration and usage statistics.
 */
export async function getUserConfig(username: string): Promise<Record<string, string | undefined>> {
  validateUsername(username);

  return executeRequest(
    async () => {
      const response = await axios.get(
        `${DA_URL}/CMD_API_SHOW_USER_CONFIG`,
        {
          params: { user: username },
          auth: getAuth(),
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'GetUserConfig', 200, response.data);
      }

      return parseResponseData(response.data) as Record<string, string | undefined>;
    },
    `GetUserConfig-${username}`
  ).catch((error: unknown) => {
     const u = unwrapDAError(error);
    const errorMessage = parseDAError(u.data) || u.message;
     serverLogger.error(`DirectAdmin Get User Config Error (${username}):`, errorMessage);
     throw new Error(`Failed to fetch user config: ${errorMessage}`);
  });
}

/**
 * Fetches real-time user usage statistics.
 */
export async function getUserUsage(username: string): Promise<Record<string, string | undefined>> {
  validateUsername(username);

  return executeRequest(
    async () => {
      const response = await axios.get(
        `${DA_URL}/CMD_API_SHOW_USER_USAGE`,
        {
          params: { user: username },
          auth: getAuth(),
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'GetUserUsage', 200, response.data);
      }

      return parseResponseData(response.data) as Record<string, string | undefined>;
    },
    `GetUserUsage-${username}`
  ).catch((error: unknown) => {
     const u = unwrapDAError(error);
    const errorMessage = parseDAError(u.data) || u.message;
     serverLogger.error(`DirectAdmin Get User Usage Error (${username}):`, errorMessage);
     throw new Error(`Failed to fetch user usage: ${errorMessage}`);
  });
}

/**
 * Fetches the list of domains for a user.
 */
export async function getUserDomains(username: string): Promise<string[]> {
  validateUsername(username);

  return executeRequest(
    async () => {
      const response = await axios.get(
        `${DA_URL}/CMD_API_SHOW_USER_DOMAINS`,
        {
          params: { user: username },
          auth: getAuth(),
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'GetUserDomains', 200, response.data);
      }

      // Response is usually a URL-encoded list list[]=domain.com&list[]=domain2.com or similar
      // Or in newer JSON apis, an array
      const data = parseResponseData(response.data) as Record<string, string | string[] | undefined>;

      const rawList = data['list[]'] || data.list || [];
      let domains = Array.isArray(rawList) ? rawList : [rawList];

      // Handle case where domains are keys (e.g. domain.com=stats...)
      if (domains.length === 0 || (domains.length === 1 && !domains[0])) {
          domains = Object.keys(data).filter(k =>
              k !== 'error' && k !== 'text' && k !== 'details' && k.includes('.')
          );
      }

      return domains.filter(Boolean);
    },
    `GetUserDomains-${username}`
  ).catch((error: unknown) => {
      const u = unwrapDAError(error);
    const errorMessage = parseDAError(u.data) || u.message;
      serverLogger.warn(`DirectAdmin Get User Domains Error (${username}): ${errorMessage}`);
      // Return empty array on failure to be safe, or throw if critical?
      // Throwing allows the caller to decide.
      throw new Error(`Failed to fetch user domains: ${errorMessage}`);
  });
}

/**
 * Changes the hosting package for a user.
 */
export async function changePackage(username: string, newPackage: string) {
  validateUsername(username);
  newPackage = normalizePackageName(newPackage);
  validatePackageName(newPackage);

  return executeRequest(
    async () => {
      const response = await axios.post(
        `${DA_URL}/CMD_API_MODIFY_USER`,
        new URLSearchParams({
          action: 'package',
          user: username,
          package: newPackage
        }).toString(),
        {
          auth: getAuth(),
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'ChangePackage', 200, response.data);
      }

      serverLogger.info(`DirectAdmin: Package changed for user ${username} to ${newPackage}`);
      return response.data;
    },
    `ChangePackage-${username}`
  );
}

/**
 * Suspends a user account.
 */
export async function suspendUser(username: string, reason: string = 'Admin Action') {
  validateUsername(username);

  return executeRequest(
    async () => {
      const response = await axios.post(
        `${DA_URL}/CMD_API_SELECT_USERS`,
        new URLSearchParams({
          location: 'CMD_SELECT_USERS',
          dosuspend: 'Suspend',
          select0: username,
          reason: reason
        }).toString(),
        {
          auth: getAuth(),
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'SuspendUser', 200, response.data);
      }

      serverLogger.info(`DirectAdmin: User suspended: ${username}`);
      return response.data;
    },
    `SuspendUser-${username}`
  );
}

/**
 * Unsuspends a user account.
 */
export async function unsuspendUser(username: string) {
  validateUsername(username);

  return executeRequest(
    async () => {
      const response = await axios.post(
        `${DA_URL}/CMD_API_SELECT_USERS`,
        new URLSearchParams({
          location: 'CMD_SELECT_USERS',
          dounsuspend: 'Unsuspend',
          select0: username
        }).toString(),
        {
          auth: getAuth(),
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'UnsuspendUser', 200, response.data);
      }

      serverLogger.info(`DirectAdmin: User unsuspended: ${username}`);
      return response.data;
    },
    `UnsuspendUser-${username}`
  );
}

/**
 * Deletes a user account.
 */
export async function deleteUser(username: string) {
  validateUsername(username);

  return executeRequest(
    async () => {
      const response = await axios.post(
        `${DA_URL}/CMD_API_SELECT_USERS`,
        new URLSearchParams({
          location: 'CMD_SELECT_USERS',
          delete: 'Delete',
          confirmed: 'Confirm',
          select0: username
        }).toString(),
        {
          auth: getAuth(),
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'DeleteUser', 200, response.data);
      }

      serverLogger.info(`DirectAdmin: User deleted: ${username}`);
      return response.data;
    },
    `DeleteUser-${username}`
  );
}

/**
 * Check if a domain already exists on the server.
 * Uses CMD_API_SHOW_DOMAIN to check existence.
 */
export async function domainExists(domain: string): Promise<boolean> {
  if (!domain) return false;

  // Check if domain exists by trying to view it
  // We don't need a specific user, we can check as admin or just try to resolve it.
  // However, DirectAdmin API usually requires a user context to "show" a domain
  // OR we can check via CMD_API_SHOW_ALL_DOMAINS which lists everything (heavy for large servers).
  // A better way is to try `CMD_API_DOMAIN_OWNERS` which lists domains and their owners.

  return executeRequest(
    async () => {
      const response = await axios.get(`${DA_URL}/CMD_API_DOMAIN_OWNERS`, {
          params: { domain },
          auth: getAuth(),
          timeout: DEFAULT_TIMEOUT_MS
      });

      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
          // error=1 usually means domain not found in this specific context reference,
          // BUT domain owners usually returns the owner if found, or error if not.
          // Let's rely on the output.
          return false;
      }

      const data = parseResponseData(response.data) as Record<string, string | string[] | undefined>;

      // If the domain is in the response keys or values
      if (data[domain] || Object.values(data).includes(domain)) {
          return true;
      }

      // Sometimes it returns just "domain: owner"
      return false;
    },
    `CheckDomainExists-${domain}`
  ).catch(() => {
      // If checking fails, assume false (or handle strictly? For now safely false to allow purchase attempt which will fail later if true)
      // But better to catch specific "not found" vs "server error".
      // CMD_API_DOMAIN_OWNERS returns "error=1&text=Domain not found" if not found.
      return false;
  });
}

/**
 * List all users on the DirectAdmin server
 */
export async function listUsers(): Promise<string[]> {
  return executeRequest(
    async () => {
      const response = await axios.get(`${DA_URL}/CMD_API_SHOW_USERS`, {
        auth: getAuth(),
        timeout: DEFAULT_TIMEOUT_MS,
      });

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'ListUsers', 200, response.data);
      }

      const data = parseResponseData(response.data) as Record<string, string | string[] | undefined>;
      const rawList = data['list[]'] || data.list || [];
      const users = Array.isArray(rawList) ? rawList : [rawList];

      return users.filter(Boolean);
    },
    'ListUsers'
  );
}

/**
 * Fetches usage stats for ALL users on the server (Bulk)
 */
export async function getAllUserUsage(): Promise<Record<string, string | undefined>> {
  return executeRequest(
    async () => {
      // CMD_API_SHOW_ALL_USER_USAGE dumps usage stats for everyone
      const response = await axios.get(`${DA_URL}/CMD_API_SHOW_ALL_USER_USAGE`, {
        auth: getAuth(),
        timeout: DEFAULT_TIMEOUT_MS,
      });

      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(parseDAError(response.data), 'GetAllUserUsage', 200, response.data);
      }
      return parseResponseData(response.data) as Record<string, string | undefined>;
    },
    'GetAllUserUsage'
  );
}
