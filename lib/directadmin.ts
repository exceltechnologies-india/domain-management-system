/**
 * DirectAdmin API Integration — backwards-compatible barrel.
 *
 * The implementation lives in focused submodules under `./directadmin/`.
 * This file preserves the historic `DirectAdminService.<method>` surface so
 * existing call sites do not have to change.
 *
 * Submodules:
 * - ./directadmin/client    shared state, request executor, helpers, constants
 * - ./directadmin/packages  hosting package management
 * - ./directadmin/users     user accounts + SSO + domain existence
 * - ./directadmin/dns       DNS records + nameservers
 * - ./directadmin/server    server info, resellers, license
 */

import {
  DirectAdminError,
  NAMESERVERS,
  KNOWN_PACKAGES,
  normalizePackageName,
  validatePackageName,
  validateUsername,
  logDebugCredentials,
} from './directadmin/client';
import * as packages from './directadmin/packages';
import * as users from './directadmin/users';
import * as dns from './directadmin/dns';
import * as server from './directadmin/server';

export { DirectAdminError, DA_SERVER_IP } from './directadmin/client';

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
export class DirectAdminService {
  public static readonly NAMESERVERS = NAMESERVERS;
  public static readonly KNOWN_PACKAGES = KNOWN_PACKAGES;

  public static logDebugCredentials = logDebugCredentials;

  /**
   * Validate DirectAdmin Username
   * Rules: Alphanumeric, 3-14 characters, no spaces, starts with letter
   */
  static validateUsername(username: string): void {
    return validateUsername(username);
  }

  /**
   * Normalizes package name casing against known packages.
   * "standard" -> "Standard"
   * "unknown_pkg" -> "unknown_pkg"
   */
  static normalizePackageName(packageName: string): string {
    return normalizePackageName(packageName);
  }

  /**
   * Validate Package Name
   * Rules: Alphanumeric, underscores, dashes
   */
  static validatePackageName(packageName: string): void {
    return validatePackageName(packageName);
  }

  // users — SSO + account lifecycle + domain checks
  static getOneTimeLoginUrl = users.getOneTimeLoginUrl;

  // packages — hosting package management
  static listPackages = packages.listPackages;
  static getPackageDetails = packages.getPackageDetails;
  static createPackage = packages.createPackage;

  // users (continued, in original source position)
  static createUser = users.createUser;
  static getUserConfig = users.getUserConfig;
  static getUserUsage = users.getUserUsage;
  static getUserDomains = users.getUserDomains;
  static changePackage = users.changePackage;
  static suspendUser = users.suspendUser;
  static unsuspendUser = users.unsuspendUser;
  static deleteUser = users.deleteUser;

  // dns — DNS records + nameservers
  static getDNSRecords = dns.getDNSRecords;
  static deleteDNSRecords = dns.deleteDNSRecords;
  static addDNSRecord = dns.addDNSRecord;
  static updateDNSNameservers = dns.updateDNSNameservers;

  // server — system info, resellers, license
  static getServerInfo = server.getServerInfo;

  // users (continued, in original source position)
  static domainExists = users.domainExists;
  static listUsers = users.listUsers;
  static getAllUserUsage = users.getAllUserUsage;

  // server (continued, in original source position)
  static listResellers = server.listResellers;
  static getLicenseInfo = server.getLicenseInfo;
}
