import { ResellerClubAPI } from "./resellerclub";
import { PricingService } from "./pricing-service";
import { DomainSearchResult, ResellerClubResponse } from "./types";
import { serverLogger } from "./server-logger";

export class ResellerClubWrapper {
  /**
   * Search for domain availability for a single domain name
   * @param domainName The base domain name to search (e.g., "example")
   * @returns Array of availability results for various TLDs
   */
  static async searchDomain(domainName: string): Promise<DomainSearchResult[]> {
    serverLogger.info(
      `[RC-WRAPPER] Initiating domain search for "${domainName}"`
    );
    return ResellerClubAPI.searchDomain(domainName);
  }

  /**
   * Search for domain availability with a specific list of TLDs
   * @param domainName The base domain name
   * @param tlds Array of TLDs to check (e.g., ["com", "net"])
   * @returns Array of availability results
   */
  static async searchDomainWithTlds(
    domainName: string,
    tlds: string[]
  ): Promise<DomainSearchResult[]> {
    serverLogger.info(
      `[RC-WRAPPER] Initiating domain search for "${domainName}" with TLDs: ${tlds.join(
        ", "
      )}`
    );
    return ResellerClubAPI.searchDomainWithTlds(domainName, tlds);
  }

  /**
   * Register a new domain for a customer
   * @param domainName The full domain name to register
   * @param years Number of years to register
   * @param customerId The ResellerClub customer ID
   * @param nameServers Optional array of custom nameservers
   * @param contacts Optional contact IDs for admin, tech, and billing
   * @returns ResellerClub API response
   */
  static async registerDomain(
    domainName: string,
    years: number,
    customerId: number,
    nameServers?: string[],
    contacts?: {
      admin: number;
      tech: number;
      billing: number;
    },
    tldAttributes?: Record<string, string>
  ): Promise<ResellerClubResponse> {
    serverLogger.info(
      `[RC-WRAPPER] Initiating domain registration for "${domainName}"`
    );
    return ResellerClubAPI.registerDomain({
      domainName,
      years,
      customerId,
      nameServers,
      adminContactId: contacts?.admin,
      techContactId: contacts?.tech,
      billingContactId: contacts?.billing,
      tldAttributes,
    });
  }

  /**
   * Retrieve full details for a domain order
   * @param domainName The domain name to fetch details for
   * @returns Detailed domain information
   */
  static async getDomainDetails(
    domainName: string
  ): Promise<ResellerClubResponse> {
    return ResellerClubAPI.getDomainDetails(domainName);
  }

  /**
   * Get the internal ResellerClub order ID for a domain
   * @param domainName The domain name
   * @returns Object containing the orderId
   */
  static async getDomainOrderId(
    domainName: string
  ): Promise<ResellerClubResponse> {
    serverLogger.info(
      `[RC-WRAPPER] Getting order ID for "${domainName}"`
    );
    return ResellerClubAPI.getDomainOrderId(domainName);
  }

  /**
   * Get current DNS records for a domain
   * @param domainName The domain name
   * @param customerId The customer ID
   * @returns Array of DNS records
   */
  static async getDNSRecords(
    domainName: string,
    customerId: string
  ): Promise<ResellerClubResponse> {
    return ResellerClubAPI.getDNSRecords(domainName, customerId);
  }

  /**
   * Renew an existing domain registration.
   *
   * Resolves the ResellerClub order-id and current expiry timestamp automatically
   * from the domain name, then calls the renewal API.
   *
   * @param domainName The domain name (e.g. "example.com")
   * @param years      Number of years to extend (1-10)
   */
  static async renewDomain(
    domainName: string,
    years: number
  ): Promise<ResellerClubResponse> {
    serverLogger.info(`[RC-WRAPPER] Renewing domain "${domainName}" for ${years} year(s)`);

    // 1. Resolve the ResellerClub order-id from the domain name
    const orderIdResult = await ResellerClubAPI.getDomainOrderId(domainName);
    if (orderIdResult.status !== "success" || !orderIdResult.data) {
      return {
        status: "error",
        message: `Could not resolve ResellerClub order-id for "${domainName}": ${orderIdResult.message ?? "unknown error"}`,
      };
    }
    const orderId = String(orderIdResult.data);

    // 2. Fetch domain details to get the current expiry date (required by the renewal API)
    const detailsResult = await ResellerClubAPI.getDomainExpiry(domainName);
    if (detailsResult.status !== "success" || !detailsResult.data) {
      return {
        status: "error",
        message: `Could not fetch domain details for "${domainName}": ${detailsResult.message ?? "unknown error"}`,
      };
    }

    // ResellerClub returns endtime as a Unix timestamp (seconds) in the details response
    const expDateRaw = detailsResult.data?.endtime ?? detailsResult.data?.["expiry-date"];
    const expDate = expDateRaw ? Number(expDateRaw) : 0;
    if (!expDate) {
      return {
        status: "error",
        message: `Could not determine expiry date for "${domainName}" from domain details`,
      };
    }

    return ResellerClubAPI.renewDomain(orderId, years, expDate);
  }

  /**
   * Transfer a domain from another registrar
   * @param domainName The domain name
   * @param authCode The EPP/Transfer code
   * @param customerId The customer ID
   * @param contacts Optional contact IDs
   * @returns Transfer request status
   */
  static async transferDomain(
    domainName: string,
    authCode: string,
    customerId: number,
    contacts?: {
      admin: number;
      tech: number;
      billing: number;
    }
  ): Promise<ResellerClubResponse> {
    return ResellerClubAPI.transferDomain(domainName, authCode, customerId, contacts);
  }

  /**
   * Add a new DNS record to a domain
   * @param domainName The domain name
   * @param customerId The customer ID
   * @param recordData Data for the new record (type, name, value, ttl, priority)
   * @returns Status of the addition
   */
  static async addDNSRecord(
    domainName: string,
    customerId: string,
    recordData: {
      type: string;
      name: string;
      value: string;
      ttl: number;
      priority?: number;
    }
  ): Promise<ResellerClubResponse> {
    serverLogger.info(
      `[RC-WRAPPER] Adding DNS record for "${domainName}"`
    );
    return ResellerClubAPI.addDNSRecord(domainName, customerId, recordData);
  }

  /**
   * Update an existing DNS record
   * @param domainName The domain name
   * @param recordId The unique record ID to update
   * @param recordData New data for the record
   * @returns Status of the update
   */
  static async updateDNSRecord(
    domainName: string,
    recordId: string,
    recordData: {
      type: string;
      name: string;
      value: string;
      ttl: number;
      priority?: number;
    }
  ): Promise<ResellerClubResponse> {
    serverLogger.info(
      `[RC-WRAPPER] Updating DNS record for "${domainName}"`
    );
    return ResellerClubAPI.updateDNSRecord(domainName, recordId, recordData);
  }

  /**
   * Delete a DNS record
   * @param domainName The domain name
   * @param recordId The unique record ID to delete
   * @param recordData Original record data (required by some API versions)
   * @returns Status of the deletion
   */
  static async deleteDNSRecord(
    domainName: string,
    recordId: string,
    recordData: {
      type: string;
      name: string;
      value: string;
      ttl: number;
      priority?: number;
    }
  ): Promise<ResellerClubResponse> {
    serverLogger.info(
      `[RC-WRAPPER] Deleting DNS record for "${domainName}"`
    );
    return ResellerClubAPI.deleteDNSRecord(domainName, recordId, recordData);
  }

  /**
   * Reset domain nameservers to ResellerClub defaults
   * @param orderId The domain order ID
   * @returns Status of the nameserver reset
   */
  static async setDefaultNameservers(
    orderId: string
  ): Promise<ResellerClubResponse> {
    serverLogger.info(
      `[RC-WRAPPER] Setting default nameservers for order "${orderId}"`
    );
    return ResellerClubAPI.setDefaultNameservers(orderId);
  }

  /**
   * Set custom nameservers for a domain
   * @param orderId The domain order ID
   * @param nameservers Array of custom nameserver hostnames
   * @returns Status of the nameserver update
   */
  static async setCustomNameservers(
    orderId: string,
    nameservers: string[]
  ): Promise<ResellerClubResponse> {
    serverLogger.info(
      `[RC-WRAPPER] Setting custom nameservers for order "${orderId}"`
    );
    return ResellerClubAPI.setCustomNameservers(orderId, nameservers);
  }

  /**
   * Activate DNS management service (required before adding records)
   * @param domainName The domain name
   * @param orderId The domain order ID
   * @returns Status of activation
   */
  static async activateDNSManagement(
    domainName: string,
    orderId: string
  ): Promise<ResellerClubResponse> {
    serverLogger.info(
      `[RC-WRAPPER] Activating DNS management for "${domainName}" (Order ID: ${orderId})`
    );
    return ResellerClubAPI.activateDNSManagement(domainName, orderId);
  }

  /**
   * Get current nameservers for a domain
   * @param domainName The domain name
   * @returns Array of nameserver hostnames
   */
  static async getNameservers(domainName: string): Promise<string[]> {
    serverLogger.info(
      `[RC-WRAPPER] Getting nameservers for "${domainName}"`
    );
    return ResellerClubAPI.getNameservers(domainName);
  }

  /**
   * Delete or Cancel a domain registration order
   * @param orderId Internal ResellerClub order ID
   * @returns Success or error status
   */
  static async deleteDomainOrder(
    orderId: string
  ): Promise<ResellerClubResponse> {
    serverLogger.info(
      `[RC-WRAPPER] Initiating domain order deletion for order "${orderId}"`
    );
    return ResellerClubAPI.deleteDomainOrder(orderId);
  }
}
