import axios, { AxiosRequestConfig } from 'axios';
import { serverLogger } from './server-logger';
import { HOSTING_PLANS } from '@/config/hosting-plans';

const DA_URL = process.env.DIRECTADMIN_URL;
const ADMIN_USER = process.env.DIRECTADMIN_ADMIN_USER;
const API_KEY = process.env.DIRECTADMIN_API_KEY;

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
  public readonly response?: any;
  public readonly context?: string;

  constructor(message: string, context?: string, status?: number, response?: any) {
    super(message);
    this.name = 'DirectAdminError';
    this.context = context;
    this.status = status;
    this.response = response;
  }
}

export class DirectAdminService {
  public static readonly NAMESERVERS = [
    "ns1.server-136-115-64-54.da.direct",
    "ns2.server-136-115-64-54.da.direct",
  ];

  public static readonly KNOWN_PACKAGES = Object.values(HOSTING_PLANS).map(p => p.serverPackage);

  // Rate limiting: Track last request time
  private static lastRequestTime = 0;
  private static readonly MIN_REQUEST_INTERVAL_MS = 500;
  private static readonly DEFAULT_TIMEOUT_MS = 8000;

  // Circuit breaker: open after 5 consecutive failures, reset after 60s
  private static circuitFailures = 0;
  private static circuitOpenUntil = 0;
  private static readonly CIRCUIT_THRESHOLD = 5;
  private static readonly CIRCUIT_RESET_MS = 60_000;

  // Slow-request threshold
  private static readonly SLOW_REQUEST_MS = 2000;

  // Request queue to serialize all DA requests
  private static requestQueue: Promise<any> = Promise.resolve();

  private static get auth() {
    if (!ADMIN_USER || !API_KEY) {
      serverLogger.error('DirectAdmin credentials missing.');
      throw new Error('DirectAdmin credentials (ADMIN_USER or API_KEY) are missing in environment variables.');
    }
    return {
      username: ADMIN_USER as string,
      password: API_KEY as string,
    };
  }

  public static logDebugCredentials() {
    const user = ADMIN_USER || 'undefined';
    const key = API_KEY || 'undefined';
    serverLogger.info(`[DA-DEBUG] Configured User: ${user.substring(0, 2)}***, Key Length: ${key.length}`);
  }

  /**
   * Validate credentials format before making any network request
   * This prevents triggering 401/403 errors that could lead to IP blacklisting
   */
  private static validateCredentials(): void {
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
  private static async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL_MS) {
      const waitTime = this.MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
      serverLogger.info(`[DA-RATE-LIMIT] Waiting ${waitTime}ms before next request`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * Centralized request executor with protection features
   * - Validates credentials before making request
   * - Enforces rate limiting
   * - Retries on network errors (NOT on auth errors)
   * - Serializes all requests through a queue
   */
  private static async executeRequest<T>(
    requestFn: () => Promise<T>,
    operation: string,
    maxRetries: number = 2
  ): Promise<T> {
    // Validate credentials first (fail-fast)
    this.validateCredentials();
    this.logDebugCredentials(); // Helpful for debugging auth issues

    // Circuit breaker: reject immediately if open
    if (Date.now() < this.circuitOpenUntil) {
      const remainingSec = Math.ceil((this.circuitOpenUntil - Date.now()) / 1000);
      throw new DirectAdminError(
        `Circuit breaker open — DirectAdmin requests paused for ${remainingSec}s after repeated failures`,
        operation, 503
      );
    }

    // Queue this request to ensure serialization
    return new Promise((resolve, reject) => {
      this.requestQueue = this.requestQueue.then(async () => {
        let lastError: any;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            // Enforce rate limiting before each attempt
            await this.enforceRateLimit();

            serverLogger.info(`[DA-REQUEST] ${operation} (attempt ${attempt + 1}/${maxRetries + 1})`);
            const requestStart = Date.now();
            const result = await requestFn();
            const elapsed = Date.now() - requestStart;
            if (elapsed > this.SLOW_REQUEST_MS) {
              serverLogger.warn(`[DA-SLOW] ${operation} took ${elapsed}ms`);
            }
            
            // Global check: If result is a string resembling HTML, it's likely a login page intercepting the API call
            if (typeof result === 'string' && (result.includes('<!DOCTYPE html>') || result.includes('<html'))) {
                 // Try to get the final URL to see if it redirected
                 const finalUrl = (result as any)?.config?.url || 'unknown';
                 const errorMsg = `DirectAdmin returned HTML (Login Page) from ${finalUrl}. Check credentials, IP allowlist, or if 2FA is enabled.`;
                 
                 serverLogger.error(`[DA-FAIL] ${operation}: ${errorMsg}`);
                 // Do not retry.
                 throw new DirectAdminError(errorMsg, operation, 401, { error: 'Auth/IP restriction detected (Login Page returned)' });
            }

            serverLogger.info(`[DA-REQUEST] ${operation} succeeded`);
            // Reset circuit breaker on success
            DirectAdminService.circuitFailures = 0;
            resolve(result);
            return;
          } catch (error: any) {
            lastError = error;
            const status = error.response?.status;
            
            // NEVER retry on authentication errors (401/403) - fail immediately
            if (status === 401 || status === 403) {
              const daErrorMessage = this.parseDAError(error.response?.data) || 'Authentication failed';
              serverLogger.error(`[DA-REQUEST] ${operation} failed with auth error (${status}). Stopping immediately.`);
              reject(new DirectAdminError(daErrorMessage, operation, status, error.response?.data));
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
              const isConnectionError = error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND';
              
              if (isConnectionError || status === 502 || status === 503 || status === 504) {
                 let msg = "DirectAdmin server is currently unreachable";

                 if (error.code === 'ECONNREFUSED') {
                    msg = "Connection Refused: DirectAdmin server is up but port 2222 is closed or service is down.";
                 } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
                    msg = "Connection Timed Out: DirectAdmin server is unreachable. Check firewall (port 2222) and IP whitelist.";
                 } else if (error.code === 'ENOTFOUND') {
                    msg = "DNS Lookup Failed: DirectAdmin hostname does not resolve.";
                 }

                 serverLogger.error(`[DA-FAIL] ${operation} Connection Failed: ${error.message} (${error.code})`);
                 DirectAdminService.circuitFailures += 1;
                 if (DirectAdminService.circuitFailures >= DirectAdminService.CIRCUIT_THRESHOLD) {
                   DirectAdminService.circuitOpenUntil = Date.now() + DirectAdminService.CIRCUIT_RESET_MS;
                   serverLogger.error(`[DA-CIRCUIT] Circuit breaker opened after ${DirectAdminService.circuitFailures} failures — pausing for ${DirectAdminService.CIRCUIT_RESET_MS / 1000}s`);
                 }
                 reject(new DirectAdminError(msg, operation, 503, { error: msg, code: error.code || 'DA_SERVER_DOWN' }));
                 return;
              }

              // Final fallback if loop exits naturally (should generally not reach here due to reject/resolve/return)
              const daErrorMessage = this.parseDAError(error.response?.data) || error.message;
              serverLogger.error(`[DA-FAIL] ${operation} failed permanently after attempts: ${error.message}`, {
                  message: daErrorMessage,
                  status: status,
                  requestUrl: error.config?.url,
                  response: error.response?.data
              });
              DirectAdminService.circuitFailures += 1;
              if (DirectAdminService.circuitFailures >= DirectAdminService.CIRCUIT_THRESHOLD) {
                DirectAdminService.circuitOpenUntil = Date.now() + DirectAdminService.CIRCUIT_RESET_MS;
                serverLogger.error(`[DA-CIRCUIT] Circuit breaker opened after ${DirectAdminService.circuitFailures} failures — pausing for ${DirectAdminService.CIRCUIT_RESET_MS / 1000}s`);
              }
              reject(new DirectAdminError(daErrorMessage, operation, status, error.response?.data));
              return;
            }
            }
          }
      }).catch(reject);
    });
  }

  /**
   * Validate DirectAdmin Username
   * Rules: Alphanumeric, 3-14 characters, no spaces, starts with letter
   */
  static validateUsername(username: string): void {
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
  static normalizePackageName(packageName: string): string {
    if (!packageName) return packageName;
    
    const lowerInput = packageName.toLowerCase();
    const found = this.KNOWN_PACKAGES.find(p => p.toLowerCase() === lowerInput);
    
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
  static validatePackageName(packageName: string): void {
    if (!packageName) throw new Error("Package name is required");
    if (!/^[a-zA-Z0-9_\-]+$/.test(packageName)) {
      throw new Error("Invalid package name. Use only letters, numbers, underscores, and dashes.");
    }
  }

  /**
   * Helper to parse DirectAdmin error responses which can be:
   * 1. URL-encoded string (error=1&text=...)
   * 2. HTML (often just the error text wrapped in tags)
   * 3. JSON (in newer APIs)
   */
  private static parseDAError(data: any): string {
    if (!data) return "Unknown DirectAdmin error";
    
    // If it's an object with error field
    if (data.error && typeof data.error === 'string') return data.error;
    if (data.text && typeof data.text === 'string') return data.text;
    if (data.details && typeof data.details === 'string') return data.details;

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
   * Generates a one-time login URL for a specific user.
   * This is used for passwordless SSO (Single Sign-On) from our portal to DirectAdmin.
   * 
   * @param username The DirectAdmin username to log in as
   * @param redirectUrl The DirectAdmin command/page to redirect to after login (default: 'CMD_USER_STATS')
   * @returns A one-time URL that logs the user into DirectAdmin
   * @throws {Error} If SSO link generation fails
   */
  static async getOneTimeLoginUrl(username: string, redirectUrl: string = 'CMD_USER_STATS'): Promise<string> {
    this.validateUsername(username);

    // For SSO, we MUST use the "Login-As" authentication syntax (admin|username)
    // to ensure DirectAdmin generates a session for the target user context,
    // otherwise it may default to the key owner's (admin) context.
    const useAuth = username === ADMIN_USER 
      ? this.auth 
      : { username: `${ADMIN_USER}|${username}`, password: API_KEY as string };

    return this.executeRequest(
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
              timeout: this.DEFAULT_TIMEOUT_MS,
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
    ).catch((error: any) => {
      // Don't re-wrap if it's already our improved error
      if (error.message && error.message.startsWith("DirectAdmin authentication failed")) throw error;

      const responseData = error.response?.data;
      const parsedError = this.parseDAError(responseData);
      
      serverLogger.error(`DirectAdmin SSO Error for ${username}: ${parsedError}`);
      throw new Error(`Failed to generate DirectAdmin SSO link: ${parsedError}`);
    });
  }

  /**
   * Lists all existing hosting packages available on the DirectAdmin server.
   * These packages can be assigned to new or existing user accounts.
   * 
   * @returns {Promise<string[]>} Array of package names
   */
  static async listPackages(): Promise<string[]> {
    return this.executeRequest(
      async () => {
        // Use CMD_API_PACKAGES_USER as it lists packages created by the admin/reseller
        const response = await axios.get(`${DA_URL}/CMD_API_PACKAGES_USER`, {
          // params: { json: 'yes' }, // Not strictly needed for this endpoint
          auth: this.auth,
          timeout: this.DEFAULT_TIMEOUT_MS,
        });

        serverLogger.info(`[ListPackages] Status: ${response.status} Data Type: ${typeof response.data}`);
        
        // Ensure we didn't get HTML (Login page)
        if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
             throw new Error('DirectAdmin returned HTML (Login Page). Check credentials or IP allowlist.');
        }

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'ListPackages', 200, response.data);
        }

        const data = this.parseResponseData(response.data);
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
  static async getPackageDetails(packageName: string): Promise<any> {
    packageName = this.normalizePackageName(packageName);
    
    return this.executeRequest(
        async () => {
            const response = await axios.get(`${DA_URL}/CMD_API_PACKAGES_USER`, {
                params: { package: packageName },
                auth: this.auth,
                timeout: this.DEFAULT_TIMEOUT_MS,
            });

            if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
                throw new Error('DirectAdmin returned HTML (Login Page).');
            }

            // Check for error response
            if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
                 throw new DirectAdminError(this.parseDAError(response.data), 'GetPackageDetails', 200, response.data);
            }

            return this.parseResponseData(response.data);
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
  static async createPackage(packageName: string, options: any = {}) {
    packageName = this.normalizePackageName(packageName);
    this.validatePackageName(packageName);

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

    return this.executeRequest(
      async () => {
        const response = await axios.post(
          `${DA_URL}/CMD_API_MANAGE_USER_PACKAGES`,
          new URLSearchParams(payload).toString(),
          {
            auth: this.auth,
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'CreatePackage', 200, response.data);
        }

        serverLogger.info(`DirectAdmin: Package created: ${packageName}`, JSON.stringify(response.data));
        return response.data;
      },
      `CreatePackage-${packageName}`
    ).catch((error: any) => {
       if (error instanceof DirectAdminError) throw error;

       const errorMessage = this.parseDAError(error.response?.data) || error.message;
       serverLogger.error(`DirectAdmin Package Creation Error (${packageName}):`, errorMessage);
       throw new Error(`Failed to create hosting package: ${errorMessage}`);
    });
  }

  /**
   * Creates a new DirectAdmin user account and assigns a hosting package.
   * 
   * @param username Desired username for the account
   * @param email User's email address
   * @param domain Primary domain to associate with the account
   * @param packageName The hosting package name to assign
   * @param ip The IP address to assign (default: '136.115.64.54')
   * @returns DirectAdmin API response
   */
  static async createUser(username: string, email: string, domain: string, packageName: string, ip: string = '136.115.64.54') {
    this.validateUsername(username);
    packageName = this.normalizePackageName(packageName);
    this.validatePackageName(packageName);

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

    return this.executeRequest(
      async () => {
        const response = await axios.post(
          `${DA_URL}/CMD_API_ACCOUNT_USER`,
          new URLSearchParams(payload).toString(),
          {
            auth: this.auth,
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );
        
        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'CreateUser', 200, response.data);
        }

        serverLogger.info(`DirectAdmin: User created: ${username} for domain: ${domain}`);
        return response.data;
      },
      `CreateUser-${username}`
    ).catch((error: any) => {
      if (error instanceof DirectAdminError) throw error;

      const errorMessage = this.parseDAError(error.response?.data) || error.message;
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
  static async getUserConfig(username: string): Promise<any> {
    this.validateUsername(username);

    return this.executeRequest(
      async () => {
        const response = await axios.get(
          `${DA_URL}/CMD_API_SHOW_USER_CONFIG`,
          {
            params: { user: username },
            auth: this.auth,
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'GetUserConfig', 200, response.data);
        }

        return this.parseResponseData(response.data);
      },
      `GetUserConfig-${username}`
    ).catch((error: any) => {
       const errorMessage = this.parseDAError(error.response?.data) || error.message;
       serverLogger.error(`DirectAdmin Get User Config Error (${username}):`, errorMessage);
       throw new Error(`Failed to fetch user config: ${errorMessage}`);
    });
  }

  /**
   * Fetches real-time user usage statistics.
   */
  static async getUserUsage(username: string): Promise<any> {
    this.validateUsername(username);

    return this.executeRequest(
      async () => {
        const response = await axios.get(
          `${DA_URL}/CMD_API_SHOW_USER_USAGE`,
          {
            params: { user: username },
            auth: this.auth,
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'GetUserUsage', 200, response.data);
        }

        return this.parseResponseData(response.data);
      },
      `GetUserUsage-${username}`
    ).catch((error: any) => {
       const errorMessage = this.parseDAError(error.response?.data) || error.message;
       serverLogger.error(`DirectAdmin Get User Usage Error (${username}):`, errorMessage);
       throw new Error(`Failed to fetch user usage: ${errorMessage}`);
    });
  }

  /**
   * Fetches the list of domains for a user.
   */
  static async getUserDomains(username: string): Promise<string[]> {
    this.validateUsername(username);

    return this.executeRequest(
      async () => {
        const response = await axios.get(
          `${DA_URL}/CMD_API_SHOW_USER_DOMAINS`,
          {
            params: { user: username },
            auth: this.auth,
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'GetUserDomains', 200, response.data);
        }
        
        // Response is usually a URL-encoded list list[]=domain.com&list[]=domain2.com or similar
        // Or in newer JSON apis, an array
        const data = this.parseResponseData(response.data);
        
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
    ).catch((error: any) => {
        const errorMessage = this.parseDAError(error.response?.data) || error.message;
        serverLogger.warn(`DirectAdmin Get User Domains Error (${username}): ${errorMessage}`);
        // Return empty array on failure to be safe, or throw if critical? 
        // Throwing allows the caller to decide.
        throw new Error(`Failed to fetch user domains: ${errorMessage}`);
    });
  }

  /**
   * Changes the hosting package for a user.
   */
  static async changePackage(username: string, newPackage: string) {
    this.validateUsername(username);
    newPackage = this.normalizePackageName(newPackage);
    this.validatePackageName(newPackage);

    return this.executeRequest(
      async () => {
        const response = await axios.post(
          `${DA_URL}/CMD_API_MODIFY_USER`,
          new URLSearchParams({
            action: 'package',
            user: username,
            package: newPackage
          }).toString(),
          {
            auth: this.auth,
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'ChangePackage', 200, response.data);
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
  static async suspendUser(username: string, reason: string = 'Admin Action') {
    this.validateUsername(username);

    return this.executeRequest(
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
            auth: this.auth,
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'SuspendUser', 200, response.data);
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
  static async unsuspendUser(username: string) {
    this.validateUsername(username);

    return this.executeRequest(
      async () => {
        const response = await axios.post(
          `${DA_URL}/CMD_API_SELECT_USERS`,
          new URLSearchParams({
            location: 'CMD_SELECT_USERS',
            dounsuspend: 'Unsuspend',
            select0: username
          }).toString(),
          {
            auth: this.auth,
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'UnsuspendUser', 200, response.data);
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
  static async deleteUser(username: string) {
    this.validateUsername(username);

    return this.executeRequest(
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
            auth: this.auth,
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'DeleteUser', 200, response.data);
        }

        serverLogger.info(`DirectAdmin: User deleted: ${username}`);
        return response.data;
      },
      `DeleteUser-${username}`
    );
  }

  /**
   * Fetch all DNS records for a domain
   */
  static async getDNSRecords(username: string, domain: string): Promise<any[]> {
    this.validateUsername(username);

    return this.executeRequest(
      async () => {
        const response = await axios.get(`${DA_URL}/CMD_API_DNS_CONTROL`, {
          auth: { username: `${ADMIN_USER}|${username}`, password: API_KEY as string },
          timeout: this.DEFAULT_TIMEOUT_MS,
        });

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(this.parseDAError(response.data), 'GetDNSRecords', 200, response.data);
        }
        
        serverLogger.info(`DA DNS Response [${domain}]:`, typeof response.data === 'object' ? JSON.stringify(response.data) : response.data);

        // Check if response is a raw BIND zone file (typical with action=view on some DA versions)
        if (typeof response.data === 'string' && (response.data.includes('$TTL') || response.data.includes('IN\tNS') || response.data.includes('IN NS'))) {
            const lines = response.data.split('\n');
            const records: any[] = [];
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('$')) continue;

                // Regex: Name [TTL] IN Type Value
                const match = trimmed.match(/^(\S+)\s+(?:(\d+)\s+)?IN\s+(\w+)\s+(.+)$/);
                
                if (match) {
                    records.push({
                        name: match[1],
                        type: match[3],
                        value: match[4],
                        ttl: match[2]
                    });
                }
            }
            return records;
        }

        const data = this.parseResponseData(response.data);
        const records: any[] = [];
        
        // Parse the numbered response fields (name0, value0, type0, etc.)
        // We scan keys until we find no more 'nameN'
        let i = 0;
        while (data[`name${i}`] !== undefined) {
          records.push({
            name: data[`name${i}`],
            value: data[`value${i}`],
            type: data[`type${i}`],
            ttl: data[`ttl${i}`],
            // Key is often needed for deletion if provided, otherwise we construct the select string
            key: data[`key${i}`] || `name=${data[`name${i}`]}&value=${data[`value${i}`]}` 
          });
          i++;
        }

        return records;
      },
      `GetDNSRecords-${domain}`
    );
  }

  /**
   * Delete specific DNS records
   */
  static async deleteDNSRecords(username: string, domain: string, records: any[]): Promise<any> {
    if (!records || records.length === 0) return;

    return this.executeRequest(
      async () => {
        const payload = new URLSearchParams({
          domain,
          action: 'select',
        });

        records.forEach((record, index) => {
          // DirectAdmin deletion uses 'selectN' param with the encoded record value
          // Often it handles 'name=foo&value=bar' as the value
          const selectValue = record.key || `name=${record.name}&value=${record.value}`;
          payload.append(`select${index}`, selectValue);
        });

        const response = await axios.post(
          `${DA_URL}/CMD_API_DNS_CONTROL`,
          payload.toString(),
          {
            auth: { username: `${ADMIN_USER}|${username}`, password: API_KEY as string },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(this.parseDAError(response.data), 'DeleteDNSRecords', 200, response.data);
        }

        serverLogger.info(`DirectAdmin: Deleted ${records.length} DNS records for ${domain}`);
        return response.data;
      },
      `DeleteDNSRecords-${domain}`
    );
  }

  /**
   * Add a single DNS record
   */
  static async addDNSRecord(username: string, domain: string, type: string, value: string, name: string = ''): Promise<any> {
    return this.executeRequest(
      async () => {
        const payload = new URLSearchParams({
          domain,
          action: 'add',
          type,
          name: name || domain, // If name is empty, it usually defaults to domain root '@', or explicit domain
          value, 
          ttl: '14400'
        });
        
        // For NS records at root, name should be the domain itself usually, or encoded as such
        if (type === 'NS' && !name) {
             payload.set('name', domain + '.');
        }

        const response = await axios.post(
          `${DA_URL}/CMD_API_DNS_CONTROL`,
          payload.toString(),
          {
            auth: { username: `${ADMIN_USER}|${username}`, password: API_KEY as string },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: this.DEFAULT_TIMEOUT_MS,
          }
        );

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
           throw new DirectAdminError(this.parseDAError(response.data), 'AddDNSRecord', 200, response.data);
        }

        return response.data;
      },
      `AddDNSRecord-${domain}-${type}`
    );
  }

  /**
   * Update DNS nameservers for a domain
   * Completely replaces existing NS records with new ones
   */
  static async updateDNSNameservers(username: string, domain: string, nameservers: string[]): Promise<any> {
    // DISABLED: DNS sync is now handled by purchase type separation
    throw new Error("Automatic DNS syncing is disabled. DNS authority is determined at purchase time.");
  }

  /**
   * Fetches system-wide information including software versions.
   */
  static async getServerInfo(): Promise<any> {
    return this.executeRequest(
      async () => {
        const response = await axios.get(`${DA_URL}/CMD_API_SYSTEM_INFO`, {
          auth: this.auth,
          timeout: this.DEFAULT_TIMEOUT_MS,
        });

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'GetServerInfo', 200, response.data);
        }

        return this.parseResponseData(response.data);
      },
      'GetServerInfo'
    );
  }

  /**
   * Helper to parse URL-encoded response data from DirectAdmin into a JSON object.
   * DA often returns data like: key1=value1&key2=value2 or list[]=val1&list[]=val2
   */
  private static parseResponseData(data: any): any {
    if (typeof data !== 'string') return data;
    
    // If it looks like URL encoded string
    if (data.includes('=')) {
        const result: any = {};
        const params = new URLSearchParams(data);
        
        params.forEach((value, key) => {
            // If key already exists, convert to array or push to array
            if (result[key]) {
                if (Array.isArray(result[key])) {
                    result[key].push(value);
                } else {
                    result[key] = [result[key], value];
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
   * Check if a domain already exists on the server.
   * Uses CMD_API_SHOW_DOMAIN to check existence.
   */
  static async domainExists(domain: string): Promise<boolean> {
    if (!domain) return false;
    
    // Check if domain exists by trying to view it
    // We don't need a specific user, we can check as admin or just try to resolve it.
    // However, DirectAdmin API usually requires a user context to "show" a domain 
    // OR we can check via CMD_API_SHOW_ALL_DOMAINS which lists everything (heavy for large servers).
    // A better way is to try `CMD_API_DOMAIN_OWNERS` which lists domains and their owners.
    
    return this.executeRequest(
      async () => {
        const response = await axios.get(`${DA_URL}/CMD_API_DOMAIN_OWNERS`, {
            params: { domain },
            auth: this.auth,
            timeout: this.DEFAULT_TIMEOUT_MS
        });
        
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
            // error=1 usually means domain not found in this specific context reference, 
            // BUT domain owners usually returns the owner if found, or error if not.
            // Let's rely on the output.
            return false;
        }

        const data = this.parseResponseData(response.data);
        
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
  static async listUsers(): Promise<string[]> {
    return this.executeRequest(
      async () => {
        const response = await axios.get(`${DA_URL}/CMD_API_SHOW_USERS`, {
          auth: this.auth,
          timeout: this.DEFAULT_TIMEOUT_MS,
        });

        // Check for DA specific error in 200 OK response
        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'ListUsers', 200, response.data);
        }

        const data = this.parseResponseData(response.data);
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
  static async getAllUserUsage(): Promise<any> {
    return this.executeRequest(
      async () => {
        // CMD_API_SHOW_ALL_USER_USAGE dumps usage stats for everyone
        const response = await axios.get(`${DA_URL}/CMD_API_SHOW_ALL_USER_USAGE`, {
          auth: this.auth,
          timeout: this.DEFAULT_TIMEOUT_MS,
        });

        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'GetAllUserUsage', 200, response.data);
        }
        return this.parseResponseData(response.data);
      },
      'GetAllUserUsage'
    );
  }

  /**
   * List all resellers on the DirectAdmin server
   */
  static async listResellers(): Promise<string[]> {
    return this.executeRequest(
      async () => {
        const response = await axios.get(`${DA_URL}/CMD_API_SHOW_RESELLERS`, {
          auth: this.auth,
          timeout: this.DEFAULT_TIMEOUT_MS,
        });

        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'ListResellers', 200, response.data);
        }

        const data = this.parseResponseData(response.data);
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
  static async getLicenseInfo(): Promise<any> {
    return this.executeRequest(
      async () => {
        const response = await axios.get(`${DA_URL}/CMD_API_LICENSE`, {
          auth: this.auth,
          timeout: this.DEFAULT_TIMEOUT_MS,
        });

        if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
             throw new DirectAdminError(this.parseDAError(response.data), 'GetLicenseInfo', 200, response.data);
        }

        return this.parseResponseData(response.data);
      },
      'GetLicenseInfo'
    );
  }
}
