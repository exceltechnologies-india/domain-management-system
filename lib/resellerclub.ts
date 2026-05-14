/**
 * ResellerClub API Integration
 *
 * This module provides comprehensive integration with the ResellerClub API for domain management,
 * including domain search, pricing, registration, DNS management, and other domain-related operations.
 *
 * Key Features:
 * - Domain availability search with live pricing
 * - Customer and reseller pricing comparison
 * - Domain registration and management
 * - DNS record management
 * - Comprehensive error handling and logging
 *
 * @author Anutech Digital Private Limited
 * @version 2.0.0
 * @since 2024
 */

import axios, { AxiosError, AxiosResponse } from "axios";
import { ResellerClubResponse, DomainSearchResult } from "./types";
import { PricingService } from "./pricing-service";

import { tldMappings } from "./tld-mappings";
import { serverLogger } from "./server-logger";
import { getRegistrationParamPairs, mapRegistrationError } from "./tld-policies";

// Environment configuration for ResellerClub API
const RESELLERCLUB_API_URL = process.env.RESELLERCLUB_API_URL;
const RESELLERCLUB_ID = process.env.RESELLERCLUB_ID;
const RESELLERCLUB_SECRET = process.env.RESELLERCLUB_SECRET;

// Validate required environment variables
if (!RESELLERCLUB_API_URL || !RESELLERCLUB_ID || !RESELLERCLUB_SECRET) {
  throw new Error(
    "ResellerClub API configuration is missing. Please check your environment variables."
  );
}

// Configure Axios instance with ResellerClub API settings
const api = axios.create({
  baseURL: RESELLERCLUB_API_URL,
  timeout: 30000, // 30 second timeout for API requests
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

// Enhanced request interceptor with detailed logging
api.interceptors.request.use(
  (config) => {
    // Mask sensitive data in logs
    const logParams = { ...config.params };
    if (logParams["api-key"]) logParams["api-key"] = "***";
    if (logParams["auth-userid"]) logParams["auth-userid"] = "***";
    
    serverLogger.info(`[RC-REQUEST] ${config.method?.toUpperCase()} ${config.url}`, {
      baseURL: config.baseURL,
      params: logParams,
      data: config.data,
    });

    // ResellerClub's REST API requires credentials as query parameters for every request.
    // There is no header-based or POST-body authentication option in their API.
    // All calls are strictly server-to-server (Node.js → RC); no browser exposure.
    config.params = {
      ...config.params,
      "auth-userid": RESELLERCLUB_ID,
      "api-key": RESELLERCLUB_SECRET,
      "reseller-id": RESELLERCLUB_ID,
    };
    return config;
  },
  (error) => {
    serverLogger.error("[RC-REQ-ERROR]", error);
    return Promise.reject(error);
  }
);

// Enhanced response interceptor with detailed logging
api.interceptors.response.use(
  (response: AxiosResponse) => {
    serverLogger.info(`[RC-RESPONSE] ${response.status} ${response.config.url}`, {
      statusText: response.statusText,
      data: response.data,
    });
    return response;
  },
  (error: AxiosError) => {
    // Log path only — never log config.params which contains credentials
    serverLogger.error(`[RC-API-ERROR] ${error.message}`, {
      status: error.response?.status,
      statusText: error.response?.statusText,
      path: error.config?.url,
      data: error.response?.data,
      code: error.code,
    });
    return Promise.reject(error);
  }
);

/**
 * ResellerClub Engine Core Architecture
 * 
 * This class serves as the singular integration point with the ResellerClub API.
 * It abstracts away HTTP complexities (Axios interceptors), orchestrates multi-TLD 
 * search mechanics, evaluates realtime reseller margins, and manages automated 
 * provisioning for Customers and Domain Contacts.
 * 
 * Future developers should note that all methods are strictly static to prevent 
 * stateful initialization bugs across serverless requests. Error handling is
 * centralized to standardize API rejection patterns.
 */
export class ResellerClubAPI {
  /**
   * Fetch live domain pricing from ResellerClub API
   *
   * Retrieves both customer and reseller pricing data from ResellerClub API.
   * This method is used by the PricingService to get the latest pricing information.
   *
   * @returns {Promise<any>} Object containing customerPricing and resellerPricing data
   * @throws {Error} If API request fails or credentials are invalid
   *
   * @example
   * const pricing = await ResellerClubAPI.getDomainPricing();
   * console.log(pricing.customerPricing); // Customer pricing data
   * console.log(pricing.resellerPricing); // Reseller pricing data
   */
  static async getDomainPricing(): Promise<any> {
    const startTime = Date.now();
    serverLogger.info(
      `[RC-PRICING] Fetching live domain pricing from ResellerClub API`
    );

    try {
      // Fetch all working pricing APIs in parallel
      const [customerPricingResponse, resellerPricingResponse] =
        await Promise.all([
          api.get("/api/products/customer-price.json"),
          api.get("/api/products/reseller-price.json"),
        ]);

      serverLogger.info(
        `[RC-PRICING] All pricing data fetched in ${
          Date.now() - startTime
        }ms`
      );

      return {
        customerPricing: customerPricingResponse.data,
        resellerPricing: resellerPricingResponse.data,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      serverLogger.error(`[RC-PRICING-FAIL] Failed to fetch domain pricing:`, error);
      throw new Error(
        "Failed to fetch live domain pricing from ResellerClub API"
      );
    }
  }

  /**
   * Get pricing for specific TLDs
   */
  static async getTLDPricing(tlds: string[]): Promise<{ [tld: string]: any }> {
    const startTime = Date.now();

    try {
      const pricingData = await this.getDomainPricing();
      const tldPricing: { [tld: string]: any } = {};

      // Extract pricing for requested TLDs
      tlds.forEach((tld) => {
        const cleanTld = tld.startsWith(".") ? tld.substring(1) : tld;

        // Comprehensive TLD mappings for ResellerClub API
        // Comprehensive TLD mappings for ResellerClub API
        // Imported from tld-mappings.ts


        // Try different variations of the TLD name
        const tldVariations = [
          // Direct mapping first (highest priority)
          tldMappings[cleanTld],
          // Original TLD variations
          cleanTld,
          `.${cleanTld}`,
          cleanTld.toUpperCase(),
          cleanTld.toLowerCase(),
          // General ResellerClub formats
          `dot${cleanTld}`,
          `dom${cleanTld}`,
          // CentralNic formats (lower priority)
          `centralnicza${cleanTld}`,
          `centralnicus${cleanTld}`,
        ].filter(Boolean); // Remove null values

        let foundTld = null;
        for (const variation of tldVariations) {
          if (pricingData.customerPricing[variation]) {
            foundTld = variation;
            break;
          }
        }

        if (foundTld) {
          tldPricing[cleanTld] = {
            customer: pricingData.customerPricing[foundTld],
            reseller: pricingData.resellerPricing[foundTld] || null,
            tld: cleanTld,
          };
        }
      });
      
      return tldPricing;
    } catch (error) {
      serverLogger.error(`❌ [PRODUCTION] Failed to fetch TLD pricing:`, error);
      throw error;
    }
  }

  /**
   * Search for domain availability with automatic TLD detection
   *
   * This method searches for domain availability and automatically determines whether
   * to search for a specific TLD or multiple common TLDs based on the input.
   *
   * @param {string} domainName - The domain name to search (with or without TLD)
   * @returns {Promise<DomainSearchResult[]>} Array of domain search results with pricing
   *
   * @example
   * // Search for a specific domain
   * const results = await ResellerClubAPI.searchDomain("example.com");
   *
   * // Search for base domain with multiple TLDs
   * const results = await ResellerClubAPI.searchDomain("example");
   */
  static async searchDomain(domainName: string): Promise<DomainSearchResult[]> {
    const startTime = Date.now();

    // Check if domain already has a TLD
    const hasTLD = domainName.includes(".");
    const searchParams: any = {
      "domain-name": domainName,
    };

    if (!hasTLD) {
      // For domains without TLD, search with multiple TLDs
      searchParams["domain-name"] = domainName;
      searchParams.tlds = "com,net,org,info,biz,co,in,co.in";
    } else {
      // For domains with TLD, extract the base name and the full TLD
      const firstDotIndex = domainName.indexOf(".");
      const baseName = domainName.substring(0, firstDotIndex);
      const tld = domainName.substring(firstDotIndex + 1);
      
      searchParams["domain-name"] = baseName;
      searchParams.tlds = tld;
    }

    try {
      const response = await api.get("/api/domains/available.json", {
        params: searchParams,
      });

      const results: DomainSearchResult[] = [];
      const responseTime = Date.now() - startTime;

      serverLogger.info(
        `[RC-SEARCH] Domain search response received in ${responseTime}ms:`,
        {
          domain: domainName,
          hasTLD: hasTLD,
          searchParams: searchParams,
          responseStatus: response.status,
          dataKeys: Object.keys(response.data || {}),
        }
      );

      if (response.data && typeof response.data === "object") {
        // Check for API errors first
        const hasError = Object.values(response.data).some(
          (data: any) =>
            data && typeof data === "object" && data.status === "error"
        );

        if (hasError) {
          serverLogger.error(
            `[RC-SEARCH-FAIL] ResellerClub API returned error:`,
            response.data
          );
          throw new Error(
            "ResellerClub API returned an error. Please check the domain name and try again."
          );
        }

        for (const [domain, data] of Object.entries(response.data)) {
          if (typeof data === "object" && data !== null) {
            const domainData = data as any;
            // Determine domain availability based on status
            let isAvailable = domainData.status === "available";
            let domainStatus = domainData.status;

            // Log domain status for debugging
            serverLogger.info(
              `[RC-SEARCH] Domain ${domain} status: ${domainStatus}`
            );

            // Try to get live pricing first
            let price = 0;
            let currency = "INR";
            let registrationPeriod = 1;
            let pricingSource: "live" | "fallback" | "unavailable" | "taken" =
              isAvailable ? "unavailable" : "taken";

            if (isAvailable) {
              const domainParts = domain.split(".");
              const tld = domainParts.slice(1).join(".").toLowerCase(); // Get full TLD for multi-level TLDs
              try {
                if (tld) {
                  const livePricing = await PricingService.getTLDPricing([tld]);

                  if (livePricing && livePricing[tld]) {
                    const finalPrice = parseFloat(livePricing[tld].price) || 0;
                    const resellerPrice =
                      parseFloat(livePricing[tld].resellerPrice) || 0;
                    const margin =
                      finalPrice > 0 && resellerPrice > 0
                        ? ((finalPrice - resellerPrice) / finalPrice) * 100
                        : 0;

                    // Use the final price from PricingService
                    price = finalPrice;
                    currency = livePricing[tld].currency || "INR";
                    registrationPeriod =
                      livePricing[tld].registrationPeriod || 1;
                    pricingSource = "live";

                  }
                }
              } catch (error) {
                serverLogger.warn(
                  `⚠️ [PRODUCTION] Failed to fetch live customer pricing for ${domain}:`,
                  error
                );
              }

              // If no live pricing available, mark as unavailable with pricing error
              if (price === 0) {
                pricingSource = "unavailable";
                isAvailable = false; // Mark domain as unavailable if no live pricing
              }
            }

            // Processing domain

            results.push({
              domainName: domain,
              available: isAvailable,
              price: price,
              currency: currency,
              registrationPeriod: registrationPeriod, // Use actual registration period
              pricingSource: pricingSource, // Add pricing source info
            });
          } else {
            serverLogger.warn(
              `⚠️ [PRODUCTION] Skipping invalid domain data for ${domain}:`,
              data
            );
          }
        }
      } else {
        serverLogger.warn(
          `⚠️ [PRODUCTION] Invalid response data structure:`,
          response.data
        );
      }

      const availableCount = results.filter((r) => r.available).length;
      const livePricingCount = results.filter(
        (r) => r.pricingSource === "live"
      ).length;
      const totalCustomerPrice = results
        .filter((r) => r.available && r.price > 0)
        .reduce((sum, r) => sum + r.price, 0);

      // Domain search completed successfully

      return results;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      serverLogger.error(
        `❌ [PRODUCTION] Domain search failed for "${domainName}" after ${responseTime}ms:`,
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          axiosError:
            error instanceof AxiosError
              ? {
                  status: error.response?.status,
                  statusText: error.response?.statusText,
                  data: error.response?.data,
                  code: error.code,
                }
              : undefined,
        }
      );

      // Re-throw with more specific error information
      if (error instanceof AxiosError) {
        if (error.response?.status === 401) {
          throw new Error(
            "ResellerClub API authentication failed. Please check API credentials."
          );
        } else if (error.response?.status === 403) {
          throw new Error(
            "ResellerClub API access forbidden. Please check API permissions."
          );
        } else if (error.response?.status === 429) {
          throw new Error(
            "ResellerClub API rate limit exceeded. Please try again later."
          );
        } else if (error.response?.status && error.response.status >= 500) {
          throw new Error(
            "ResellerClub API server error. Please try again later."
          );
        } else if (error.code === "ECONNABORTED") {
          throw new Error(
            "ResellerClub API request timeout. Please try again."
          );
        } else if (
          error.code === "ENOTFOUND" ||
          error.code === "ECONNREFUSED"
        ) {
          throw new Error(
            "ResellerClub API connection failed. Please check network connectivity."
          );
        }
      }

      throw new Error(
        `Failed to search domain availability: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Search for domain availability with specific TLDs
   *
   * This method allows searching for a base domain name across multiple specific TLDs.
   * It's used when you want to check availability for a domain across a custom set of TLDs.
   *
   * @param {string} domainName - The base domain name (without TLD)
   * @param {string[]} tlds - Array of TLDs to search (e.g., ['com', 'net', 'org'])
   * @returns {Promise<DomainSearchResult[]>} Array of domain search results with pricing
   *
   * @example
   * // Search for 'example' across multiple TLDs
   * const results = await ResellerClubAPI.searchDomainWithTlds("example", ["com", "net", "org"]);
   *
   * // Search for 'mystore' across e-commerce TLDs
   * const results = await ResellerClubAPI.searchDomainWithTlds("mystore", ["shop", "store", "online"]);
   */
  static async searchDomainWithTlds(
    domainName: string,
    tlds: string[]
  ): Promise<DomainSearchResult[]> {
    const startTime = Date.now();

    try {
      const response = await api.get("/api/domains/available.json", {
        params: {
          "domain-name": domainName,
          tlds: tlds.join(","),
        },
      });

      const results: DomainSearchResult[] = [];
      const responseTime = Date.now() - startTime;

      serverLogger.info(
        `[RC-SEARCH-TLDS] Domain search response received in ${responseTime}ms:`,
        {
          domain: domainName,
          tlds: tlds,
          searchParams: { "domain-name": domainName, tlds: tlds.join(",") },
          responseStatus: response.status,
          dataKeys: Object.keys(response.data || {}),
        }
      );

      if (response.data && typeof response.data === "object") {
        // Check for API errors first
        const hasError = Object.values(response.data).some(
          (data: any) =>
            data && typeof data === "object" && data.status === "error"
        );

        if (hasError) {
          serverLogger.error(
            `[RC-SEARCH-TLDS-FAIL] ResellerClub API returned error:`,
            response.data
          );
          throw new Error(
            "ResellerClub API returned an error. Please check the domain name and TLDs and try again."
          );
        }

        // Log the raw response for debugging
        serverLogger.info(`[RC-SEARCH-TLDS] Raw API response:`, response.data);
        serverLogger.info(`[RC-SEARCH-TLDS] API request params:`, {
          "domain-name": domainName,
          tlds: tlds.join(","),
        });

        for (const [domain, data] of Object.entries(response.data)) {
          // Check if domain name is malformed (contains commas or other issues) FIRST
          // This happens when ResellerClub returns a concatenated key like "excelpro.com,net,org"
          if (domain.includes(",")) {
            serverLogger.warn(
              `[RC-SEARCH-WARN] Malformed domain name detected: "${domain}"`
            );

            const baseDomain = domainName; 
            const parts = domain.split(",").map((part) => part.trim());
            const malformedTlds: string[] = [];

            if (parts.length > 0 && parts[0].includes(".")) {
              const firstTld = parts[0].split(".").slice(1).join(".");
              if (firstTld) malformedTlds.push(firstTld);
              malformedTlds.push(...parts.slice(1));
            }

            for (const tld of malformedTlds) {
              if (tld && tld.length > 0) {
                const cleanDomain = `${baseDomain}.${tld}`;
                  
                let isAvailable = false;
                let domainStatus = "unknown";

                try {
                  const availabilityResponse = await api.get(
                    "/api/domains/available.json",
                    {
                      params: {
                        "domain-name": baseDomain,
                        tlds: tld,
                      },
                    }
                  );

                  if (
                    availabilityResponse.data &&
                    typeof availabilityResponse.data === "object"
                  ) {
                    const domainData = availabilityResponse.data[cleanDomain];
                    if (domainData && typeof domainData === "object") {
                      domainStatus = domainData.status || "unknown";
                      isAvailable = domainStatus === "available";
                    }
                  }
                } catch (error) {
                  serverLogger.error(
                    `❌ [PRODUCTION] Failed to check availability for ${cleanDomain}:`,
                    error
                  );
                  continue;
                }

                if (!isAvailable) {
                  results.push({
                    domainName: cleanDomain,
                    available: false,
                    price: 0,
                    currency: "INR",
                    registrationPeriod: 1,
                    pricingSource: "taken",
                  });
                  continue;
                }

                let price = 0;
                let currency = "INR";
                let registrationPeriod = 1;
                let pricingSource:
                  | "live"
                  | "fallback"
                  | "unavailable"
                  | "taken" = "unavailable";

                try {
                    const livePricing = await PricingService.getTLDPricing([tld]);

                    if (livePricing && livePricing[tld]) {
                      price = parseFloat(livePricing[tld].price) || 0;
                      currency = livePricing[tld].currency || "INR";
                      registrationPeriod =
                        livePricing[tld].registrationPeriod || 1;
                      pricingSource = "live";
                    } else {
                      serverLogger.warn(
                        `[PRODUCTION] No live pricing available for TLD: ${tld}`,
                         { domain: cleanDomain }
                      );
                    }
                } catch (error) {
                  serverLogger.error(
                    `❌ [PRODUCTION] Failed to fetch pricing for TLD ${tld}:`,
                    error
                  );
                }

                if (price > 0) {
                  results.push({
                    domainName: cleanDomain,
                    available: isAvailable,
                    price: price,
                    currency: currency,
                    registrationPeriod: registrationPeriod,
                    pricingSource: pricingSource,
                  });
                } else {
                  serverLogger.warn(
                    `[PRODUCTION] Skipping ${cleanDomain} - no valid pricing`,
                     { domain: cleanDomain }
                  );
                }
              }
            }
            continue;
          }

          // Now validate domain name format and base domain match for normal cases
          const domainParts = domain.split(".");
          const isValidFormat =
            domainParts.length >= 2 && // Allow multi-level TLDs like .co.in, .co.uk
            !domain.includes("..") &&
            domainParts[0].length > 0 &&
            domainParts[domainParts.length - 1].length > 0; // Check last part (TLD)

          const expectedBaseDomain = domainName.toLowerCase();
          const actualBaseDomain = domainParts[0].toLowerCase();
          const isCorrectBaseDomain = actualBaseDomain === expectedBaseDomain;

          if (!isValidFormat || !isCorrectBaseDomain) {
            serverLogger.warn(
              `⚠️ [PRODUCTION] Invalid domain detected: "${domain}" (format: ${isValidFormat}, base match: ${isCorrectBaseDomain}) - skipping`
            );
            continue;
          }

          if (typeof data === "object" && data !== null) {
            const domainData = data as any;
            // Determine domain availability based on status
            let isAvailable = domainData.status === "available";
            let domainStatus = domainData.status;



            // Try to get live pricing first
            let price = 0;
            let currency = "INR";
            let registrationPeriod = 1;
            let pricingSource: "live" | "fallback" | "unavailable" | "taken" =
              isAvailable ? "unavailable" : "taken";

            // Get TLD and live pricing for all domains
            const domainParts = domain.split(".");
            const tld = domainParts.slice(1).join(".").toLowerCase(); // Get full TLD for multi-level TLDs
            let livePricing: any = null;

            if (isAvailable && tld) {
              try {
                livePricing = await PricingService.getTLDPricing([tld]);

                if (livePricing && livePricing[tld]) {
                  const customerPrice = parseFloat(livePricing[tld].price) || 0;
                  const resellerPrice =
                    parseFloat(livePricing[tld].resellerPrice) || 0;
                  const margin =
                    customerPrice > 0 && resellerPrice > 0
                      ? ((customerPrice - resellerPrice) / customerPrice) * 100
                      : 0;

                  price = customerPrice; // Use customer price for display
                  currency = livePricing[tld].currency || "INR";
                  pricingSource = "live";



                }
              } catch (error) {
                serverLogger.warn(
                  `⚠️ [PRODUCTION] Failed to fetch live customer pricing for ${domain}:`,
                  error
                );
              }

              // If no live pricing available, mark as unavailable with pricing error
              if (price === 0) {
                pricingSource = "unavailable";
                isAvailable = false; // Mark domain as unavailable if no live pricing
              }
            }

            // Processing domain

            results.push({
              domainName: domain,
              available: isAvailable,
              price: price,
              currency: currency,
              registrationPeriod: registrationPeriod, // Use actual registration period
              pricingSource: pricingSource, // Add pricing source info
            });
          } else {
            serverLogger.warn(
              `⚠️ [PRODUCTION] Skipping invalid domain data for ${domain}:`,
              data
            );
          }
        }
      } else {
        serverLogger.warn(
          `⚠️ [PRODUCTION] Invalid response data structure:`,
          response.data
        );
      }

      const availableCount = results.filter((r) => r.available).length;
      const livePricingCount = results.filter(
        (r) => r.pricingSource === "live"
      ).length;
      const totalCustomerPrice = results
        .filter((r) => r.available && r.price > 0)
        .reduce((sum, r) => sum + r.price, 0);

      // Domain search completed successfully

      return results;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      serverLogger.error(
        `❌ [PRODUCTION] Domain search failed for "${domainName}" with TLDs ${tlds.join(
          ", "
        )} after ${responseTime}ms:`,
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          axiosError:
            error instanceof AxiosError
              ? {
                  status: error.response?.status,
                  statusText: error.response?.statusText,
                  data: error.response?.data,
                  code: error.code,
                }
              : undefined,
        }
      );

      // Re-throw with more specific error information
      if (error instanceof AxiosError) {
        if (error.response?.status === 401) {
          throw new Error(
            "ResellerClub API authentication failed. Please check API credentials."
          );
        } else if (error.response?.status === 403) {
          throw new Error(
            "ResellerClub API access forbidden. Please check API permissions."
          );
        } else if (error.response?.status === 429) {
          throw new Error(
            "ResellerClub API rate limit exceeded. Please try again later."
          );
        } else if (error.response?.status && error.response.status >= 500) {
          throw new Error(
            "ResellerClub API server error. Please try again later."
          );
        } else if (error.code === "ECONNABORTED") {
          throw new Error(
            "ResellerClub API request timeout. Please try again."
          );
        } else if (
          error.code === "ENOTFOUND" ||
          error.code === "ECONNREFUSED"
        ) {
          throw new Error(
            "ResellerClub API connection failed. Please check network connectivity."
          );
        }
      }

      throw new Error(
        `Failed to search domain availability: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Get reseller pricing for a specific TLD
   */
  static async getResellerPricingForTLD(
    tld: string
  ): Promise<{ price: number; currency: string } | null> {
    try {
      // Fetch reseller pricing
      const response = await api.get("/api/products/reseller-price.json");

      if (response.data && response.data[tld]) {
        const tldPricing = response.data[tld];

        // Get registration price (addnewdomain) for 1 year
        if (tldPricing.addnewdomain && tldPricing.addnewdomain["1"]) {
          const price = parseFloat(tldPricing.addnewdomain["1"]);
          const currency = "INR"; // ResellerClub typically returns prices in INR

          return { price, currency };
        }
      }

      return null;
    } catch (error) {
      serverLogger.error(
        `❌ [PRODUCTION] Failed to fetch reseller pricing for ${tld}:`,
        error
      );
      return null;
    }
  }

  /**
   * Get Reseller Details including wallet balance
   * 
   * Retrieves reseller account details including available balance, 
   * unutilised selling balance, and locked balance.
   * 
   * @returns {Promise<{status: string, data?: any, error?: string}>} Reseller details with balance information
   * @throws {Error} If API request fails or credentials are invalid
   * 
   * @example
   * const result = await ResellerClubAPI.getResellerDetails();
   * if (result.status === 'success') {
   *   console.log('Available Balance:', result.data.availablebalance);
   * }
   */
  static async getResellerDetails(): Promise<{
    status: string;
    data?: {
      resellerid?: string;
      name?: string;
      availablebalance?: string;
      unutilisedsellingbalance?: string;
      lockedbalance?: string;
      [key: string]: any;
    };
    error?: string;
  }> {
    const startTime = Date.now();
    serverLogger.info(
      `💰 [RESELLER] Fetching ResellerClub reseller details and wallet balance`
    );

    try {
      const response = await api.get("/api/resellers/details.json");

      const responseTime = Date.now() - startTime;
      serverLogger.info(
        `✅ [RESELLER] Reseller details fetched in ${responseTime}ms:`,
        {
          status: response.status,
          data: response.data,
        }
      );

      // Log the raw response structure for debugging
      serverLogger.info(`🔍 [RESELLER] Raw response.data type:`, typeof response.data);
      serverLogger.info(`🔍 [RESELLER] Raw response.data keys:`, response.data ? Object.keys(response.data) : 'null');
      serverLogger.info(`🔍 [RESELLER] Raw response.data full:`, JSON.stringify(response.data, null, 2));

      if (response.data) {
        // Check if response.data is already the balance data or if it's wrapped
        // Some APIs return { status: 'success', data: {...} }
        // Others return the data directly
        let actualData = response.data;
        
        // If response.data has a 'data' property, use that
        if (actualData && typeof actualData === 'object' && actualData.data) {
          serverLogger.info(`🔍 [RESELLER] Found nested 'data' in response, using it`);
          actualData = actualData.data;
        }
        
        return {
          status: "success",
          data: actualData,
        };
      } else {
        return {
          status: "error",
          error: "No data received from API",
        };
      }
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      serverLogger.error(
        `❌ [RESELLER] Failed to fetch reseller details in ${responseTime}ms:`,
        error
      );

      // Handle different error scenarios
      if (error.response) {
        // API returned an error response
        return {
          status: "error",
          error:
            error.response.data?.message ||
            error.response.data?.error ||
            `API Error: ${error.response.status} ${error.response.statusText}`,
        };
      } else if (error.request) {
        // Request was made but no response received
        return {
          status: "error",
          error: "No response from ResellerClub API",
        };
      } else {
        // Error setting up the request
        return {
          status: "error",
          error: error.message || "Unknown error occurred",
        };
      }
    }
  }

  /**
   * Check if a customer exists in ResellerClub system and get their ID
   */
  static async getCustomerId(
    username: string
  ): Promise<{ status: string; customerId?: number; error?: string }> {
    const startTime = Date.now();
    serverLogger.info(
      `🔍 [PRODUCTION] Checking if ResellerClub customer exists: ${username}`
    );

    try {
      const response = await api.get("/api/customers/details.json", {
        params: {
          username: username,
        },
      });

      const responseTime = Date.now() - startTime;
      serverLogger.info(
        `✅ [PRODUCTION] Customer details fetched in ${responseTime}ms:`,
        {
          responseData: response.data,
          status: response.status,
        }
      );

      // If we get here, customer exists
      if (response.data && response.data.customerid) {
        return {
          status: "success",
          customerId: parseInt(response.data.customerid),
        };
      } else {
        return {
          status: "error",
          error: "Customer not found",
        };
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      serverLogger.info(
        `ℹ️ [PRODUCTION] Customer check completed in ${responseTime}ms - Customer does not exist`
      );

      // If customer doesn't exist, ResellerClub returns an error
      // This is expected behavior, so we return "not found" status
      return {
        status: "not_found",
        error: "Customer does not exist",
      };
    }
  }

  /**
   * Create a customer in ResellerClub system
   */
  static async createCustomer(customerData: {
    username: string;
    passwd: string;
    name: string;
    company?: string;
    addressLine1: string;
    city: string;
    state: string;
    country: string;
    zipcode: string;
    phoneCc: string;
    phone: string;
    langPref?: string;
  }): Promise<{ status: string; data?: any; error?: string }> {
    const startTime = Date.now();
    serverLogger.info(
      `🚀 [PRODUCTION] Creating ResellerClub customer: ${customerData.username}`
    );

    try {
      const response = await api.post("/api/customers/signup.json", null, {
        params: {
          username: customerData.username,
          passwd: customerData.passwd,
          name: customerData.name,
          company: customerData.company || customerData.name, // Use name as company if not provided
          "address-line-1": customerData.addressLine1,
          city: customerData.city,
          state: customerData.state,
          country: customerData.country,
          zipcode: customerData.zipcode,
          "phone-cc": customerData.phoneCc,
          phone: customerData.phone,
          "lang-pref": customerData.langPref || "en",
          "reseller-id":
            process.env.RESELLERCLUB_RESELLER_ID || process.env.RESELLERCLUB_ID, // Add reseller ID
        },
      });

      const responseTime = Date.now() - startTime;
      serverLogger.info(
        `✅ [PRODUCTION] Customer created successfully in ${responseTime}ms:`,
        {
          responseData: response.data,
          status: response.status,
        }
      );

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      serverLogger.error(
        `❌ [PRODUCTION] Customer creation failed after ${responseTime}ms:`,
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          axiosError:
            error instanceof AxiosError
              ? {
                  status: error.response?.status,
                  statusText: error.response?.statusText,
                  data: error.response?.data,
                  code: error.code,
                }
              : undefined,
          customerData: {
            username: customerData.username,
            name: customerData.name,
          },
        }
      );

      return {
        status: "error",
        error:
          error instanceof AxiosError
            ? error.response?.data?.message || error.message
            : "Unknown error occurred",
      };
    }
  }

  /**
   * Modify/Update customer details in ResellerClub system
   * 
   * This method updates an existing customer's profile information in ResellerClub.
   * Used to sync user profile changes from the application to ResellerClub.
   * 
   * @param customerData - Object containing username (email) and fields to update
   * @returns Promise with status and response data
   */
  static async modifyCustomer(customerData: {
    username: string;
    customerId: number;
    name?: string;
    company?: string;
    addressLine1?: string;
    city?: string;
    state?: string;
    country?: string;
    zipcode?: string;
    phoneCc?: string;
    phone?: string;
  }): Promise<{ status: string; data?: any; error?: string }> {
    const startTime = Date.now();
    serverLogger.info(
      `🔄 [PRODUCTION] Modifying ResellerClub customer: ${customerData.username} (ID: ${customerData.customerId})`
    );


    try {
      // Build params object with only provided fields
      // ResellerClub requires BOTH username and customer-id, plus lang-pref
      const params: any = {
        username: customerData.username,
        "customer-id": customerData.customerId,
        "lang-pref": "en", // Required by ResellerClub
      };

      if (customerData.name) params.name = customerData.name;
      if (customerData.company) params.company = customerData.company;
      if (customerData.addressLine1) params["address-line-1"] = customerData.addressLine1;
      if (customerData.city) params.city = customerData.city;
      if (customerData.state) params.state = customerData.state;
      if (customerData.country) params.country = customerData.country;
      if (customerData.zipcode) params.zipcode = customerData.zipcode;
      if (customerData.phoneCc) params["phone-cc"] = customerData.phoneCc;
      if (customerData.phone) params.phone = customerData.phone;

      const response = await api.post("/api/customers/modify.json", null, {
        params,
      });

      const responseTime = Date.now() - startTime;
      serverLogger.info(
        `✅ [PRODUCTION] Customer modified successfully in ${responseTime}ms:`,
        {
          username: customerData.username,
          responseData: response.data,
          status: response.status,
        }
      );

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      serverLogger.error(
        `❌ [PRODUCTION] Customer modification failed after ${responseTime}ms:`,
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          axiosError:
            error instanceof AxiosError
              ? {
                  status: error.response?.status,
                  statusText: error.response?.statusText,
                  data: error.response?.data,
                  code: error.code,
                }
              : undefined,
          customerData: {
            username: customerData.username,
          },
        }
      );

      return {
        status: "error",
        error:
          error instanceof AxiosError
            ? error.response?.data?.message || error.message
            : "Unknown error occurred",
      };
    }
  }

  /**
   * Modify an existing contact in ResellerClub system.
   *
   * Contact records (not customer records) are what RC attaches to each
   * domain as the registrant/admin/tech/billing WHOIS contact. Updating the
   * customer alone does NOT update the contact already linked to a domain —
   * this method is the missing piece for keeping WHOIS data accurate after
   * a user later corrects their profile.
   *
   * @returns { status: "success" | "error", data?, error? }
   */
  static async modifyContact(contactData: {
    contactId: number;
    name?: string;
    company?: string;
    email?: string;
    addressLine1?: string;
    city?: string;
    state?: string;
    country?: string;
    zipcode?: string;
    phoneCc?: string;
    phone?: string;
  }): Promise<ResellerClubResponse> {
    const startTime = Date.now();
    serverLogger.info(
      `🔄 [PRODUCTION] Modifying ResellerClub contact (ID: ${contactData.contactId})`
    );

    try {
      const params: any = {
        "contact-id": contactData.contactId,
      };

      if (contactData.name) params.name = contactData.name;
      if (contactData.company) params.company = contactData.company;
      if (contactData.email) params.email = contactData.email;
      if (contactData.addressLine1) params["address-line-1"] = contactData.addressLine1;
      if (contactData.city) params.city = contactData.city;
      if (contactData.state) params.state = contactData.state;
      if (contactData.country) params.country = contactData.country;
      if (contactData.zipcode) params.zipcode = contactData.zipcode;
      if (contactData.phoneCc) params["phone-cc"] = contactData.phoneCc;
      if (contactData.phone) params.phone = contactData.phone;

      const response = await api.post("/api/contacts/modify.json", null, { params });

      const responseTime = Date.now() - startTime;
      serverLogger.info(
        `✅ [PRODUCTION] Contact modified successfully in ${responseTime}ms:`,
        {
          contactId: contactData.contactId,
          responseData: response.data,
          status: response.status,
        }
      );

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      serverLogger.error(
        `❌ [PRODUCTION] Contact modification failed after ${responseTime}ms:`,
        {
          error: error instanceof Error ? error.message : "Unknown error",
          axiosError:
            error instanceof AxiosError
              ? {
                  status: error.response?.status,
                  statusText: error.response?.statusText,
                  data: error.response?.data,
                  code: error.code,
                }
              : undefined,
          contactId: contactData.contactId,
        }
      );

      return {
        status: "error",
        message:
          error instanceof AxiosError
            ? error.response?.data?.message || error.message
            : "Unknown error occurred",
      };
    }
  }

  /**
   * Create a contact in ResellerClub system
   */
  static async createContact(contactData: {
    customerId: number;
    name: string;
    company?: string;
    email: string;
    addressLine1: string;
    city: string;
    state: string;
    country: string;
    zipcode: string;
    phoneCc: string;
    phone: string;
    type: "Contact" | "CaDomain" | "IrtContact";
  }): Promise<{ status: string; data?: any; error?: string }> {
    const startTime = Date.now();
    serverLogger.info(
      `🚀 [PRODUCTION] Creating ResellerClub contact: ${contactData.name} (${contactData.email})`
    );

    try {
      const response = await api.post("/api/contacts/add.json", null, {
        params: {
          "customer-id": contactData.customerId,
          name: contactData.name,
          company: contactData.company || contactData.name, // Use name as company if not provided
          email: contactData.email,
          "address-line-1": contactData.addressLine1,
          city: contactData.city,
          state: contactData.state,
          country: contactData.country,
          zipcode: contactData.zipcode,
          "phone-cc": contactData.phoneCc,
          phone: contactData.phone,
          type: contactData.type,
          "reseller-id":
            process.env.RESELLERCLUB_RESELLER_ID || process.env.RESELLERCLUB_ID, // Add reseller ID
        },
      });

      const responseTime = Date.now() - startTime;
      serverLogger.info(
        `✅ [PRODUCTION] Contact created successfully in ${responseTime}ms:`,
        {
          responseData: response.data,
          status: response.status,
        }
      );

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      serverLogger.error(
        `❌ [PRODUCTION] Contact creation failed after ${responseTime}ms:`,
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          axiosError:
            error instanceof AxiosError
              ? {
                  status: error.response?.status,
                  statusText: error.response?.statusText,
                  data: error.response?.data,
                  code: error.code,
                }
              : undefined,
          contactData: {
            name: contactData.name,
            email: contactData.email,
            customerId: contactData.customerId,
          },
        }
      );

      return {
        status: "error",
        error:
          error instanceof AxiosError
            ? error.response?.data?.message || error.message
            : "Unknown error occurred",
      };
    }
  }

  /**
   * Get or create a ResellerClub customer and contact for a user
   */
  static async getOrCreateCustomerAndContact(userData: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
    phoneCc?: string;
    companyName?: string;
    address?: {
      line1: string;
      city: string;
      state: string;
      country: string;
      zipcode: string;
    };
  }): Promise<{
    status: string;
    customerId?: number;
    contactId?: number;
    error?: string;
  }> {
    serverLogger.info(
      `🔍 [PRODUCTION] Getting or creating ResellerClub customer and contact for user: ${userData.email}`
    );

    try {
      // First, check if customer already exists
      const existingCustomer = await ResellerClubAPI.getCustomerId(
        userData.email
      );

      let customerId: number;

      if (
        existingCustomer.status === "success" &&
        existingCustomer.customerId
      ) {
        // Customer already exists, use their ID
        customerId = existingCustomer.customerId;
        serverLogger.info(
          `✅ [PRODUCTION] Found existing ResellerClub customer ${customerId} for user: ${userData.email}`
        );
      } else {
        // Customer doesn't exist, create a new one
        serverLogger.info(
          `🆕 [PRODUCTION] Customer not found, creating new ResellerClub customer for: ${userData.email}`
        );

        // Generate ResellerClub-compliant password (8-15 alphanumeric characters)
        const tempPassword = `Temp${Math.random()
          .toString(36)
          .substring(2, 10)}`;

        // Clean phone number (remove spaces and non-digits)
        const cleanPhone = userData.phone?.replace(/\D/g, "") || "0000000000";

        serverLogger.info(`🔧 [PRODUCTION] Generated ResellerClub credentials:`, {
          password: tempPassword,
          passwordLength: tempPassword.length,
          originalPhone: userData.phone,
          cleanPhone: cleanPhone,
          phoneCc: userData.phoneCc?.replace("+", "") || "91",
        });

        // Create customer
        const customerResult = await ResellerClubAPI.createCustomer({
          username: userData.email,
          passwd: tempPassword, // Generate ResellerClub-compliant password
          name: `${userData.firstName} ${userData.lastName}`,
          company:
            userData.companyName ||
            `${userData.firstName} ${userData.lastName}`, // Use companyName from user data
          addressLine1: userData.address?.line1 || "Default Address",
          city: userData.address?.city || "Default City",
          state: userData.address?.state || "Default State",
          country: userData.address?.country || "IN",
          zipcode: userData.address?.zipcode || "000000",
          phoneCc: userData.phoneCc?.replace("+", "") || "91", // Use user's phone country code or default to India
          phone: cleanPhone, // Clean phone number without spaces
          langPref: "en",
        });

        if (customerResult.status !== "success" || !customerResult.data) {
          serverLogger.error(
            `❌ [PRODUCTION] Failed to create ResellerClub customer for user ${userData.email}:`,
            customerResult.error
          );
          return {
            status: "error",
            error: `Failed to create customer: ${customerResult.error}`,
          };
        }

        // ResellerClub returns customer ID directly as a number
        customerId = parseInt(customerResult.data);
        serverLogger.info(
          `✅ [PRODUCTION] Created ResellerClub customer ${customerId} for user: ${userData.email}`
        );
      }

      // Clean phone number for contact creation (remove spaces and non-digits)
      const cleanPhone = userData.phone?.replace(/\D/g, "") || "0000000000";

      // Create contact
      const contactResult = await ResellerClubAPI.createContact({
        customerId: customerId,
        name: `${userData.firstName} ${userData.lastName}`,
        company:
          userData.companyName || `${userData.firstName} ${userData.lastName}`, // Use companyName from user data
        email: userData.email,
        addressLine1: userData.address?.line1 || "Default Address",
        city: userData.address?.city || "Default City",
        state: userData.address?.state || "Default State",
        country: userData.address?.country || "IN",
        zipcode: userData.address?.zipcode || "000000",
        phoneCc: userData.phoneCc?.replace("+", "") || "91", // Use user's phone country code or default to India
        phone: cleanPhone, // Use cleaned phone number without spaces
        type: "Contact",
      });

      if (contactResult.status !== "success" || !contactResult.data) {
        serverLogger.error(
          `❌ [PRODUCTION] Failed to create ResellerClub contact for user ${userData.email}:`,
          contactResult.error
        );
        return {
          status: "error",
          error: `Failed to create contact: ${contactResult.error}`,
        };
      }

      // ResellerClub returns contact ID directly as a number
      const contactId = parseInt(contactResult.data);
      serverLogger.info(
        `✅ [PRODUCTION] Created ResellerClub contact ${contactId} for user: ${userData.email}`
      );

      // TODO: Store customerId and contactId in your user database record
      // await updateUserResellerClubIds(userData.email, customerId, contactId);

      return {
        status: "success",
        customerId: customerId,
        contactId: contactId,
      };
    } catch (error) {
      serverLogger.error(
        `❌ [PRODUCTION] Error in getOrCreateCustomerAndContact for user ${userData.email}:`,
        error
      );
      return {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Delete or Cancel a domain registration order
   * This is used for cancelling orders stuck in "Processing" or within grace period
   */
  static async deleteDomainOrder(orderId: string): Promise<ResellerClubResponse> {
    const startTime = Date.now();
    serverLogger.info(`[RC-DELETE] Starting domain order deletion for: "${orderId}"`);

    try {
      const response = await api.post("/api/domains/delete.json", null, {
        params: {
          "order-id": orderId,
        },
      });

      const responseTime = Date.now() - startTime;
      serverLogger.info(
        `[RC-DELETE] Domain order deletion response received in ${responseTime}ms`,
        {
          orderId,
          status: response.data.status,
          message: response.data.message || response.data.actionstatusdesc,
        }
      );

      if (response.data.status?.toLowerCase() === "error") {
        return {
          status: "error",
          message: response.data.message || "Failed to delete domain order",
        };
      }

      return {
        status: "success",
        message: response.data.message || "Domain order deleted successfully",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error(`[RC-DELETE-FAIL] Failed to delete domain order ${orderId}:`, error);
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Failed to delete domain order",
      };
    }
  }

  /**
   * Register a domain
   */
  static async registerDomain(domainData: {
    domainName: string;
    years: number;
    customerId: number; // ResellerClub customer ID (numeric)
    nameServers?: string[];
    adminContactId?: number; // ResellerClub contact ID (numeric)
    techContactId?: number; // ResellerClub contact ID (numeric)
    billingContactId?: number; // ResellerClub contact ID (numeric)
    /** Per-TLD attributes collected at checkout (e.g. .us Nexus). */
    tldAttributes?: Record<string, string>;
  }): Promise<ResellerClubResponse> {
    const startTime = Date.now();
    serverLogger.info(
      `[RC-REGISTER] Starting domain registration for: "${domainData.domainName}"`,
      {
        years: domainData.years,
        customerId: domainData.customerId,
        nameServers: domainData.nameServers,
        contacts: {
          admin: domainData.adminContactId,
          tech: domainData.techContactId,
          billing: domainData.billingContactId,
        },
      }
    );

    try {
      // Always use ResellerClub nameservers as default for domain registration
      const resellerClubNameServers = [
        "deepak1299294.mercury.orderbox-dns.com",
        "deepak1299294.venus.orderbox-dns.com",
        "deepak1299294.earth.orderbox-dns.com",
        "deepak1299294.mars.orderbox-dns.com",
      ];

      // Use custom nameservers if provided, otherwise use ResellerClub defaults
      const nameServers =
        domainData.nameServers && domainData.nameServers.length > 0
          ? domainData.nameServers
          : resellerClubNameServers;

      serverLogger.info(
        `[RC-REGISTER] Using nameservers for ${domainData.domainName}:`,
        nameServers
      );

      // Prepare nameserver parameters using URLSearchParams for correct encoding
      const params = new URLSearchParams({
        "domain-name": domainData.domainName,
        years: domainData.years.toString(),
        "customer-id": domainData.customerId.toString(),
        "reg-contact-id": domainData.adminContactId?.toString() || "",
        "admin-contact-id": domainData.adminContactId?.toString() || "",
        "tech-contact-id": domainData.techContactId?.toString() || "",
        "billing-contact-id": domainData.billingContactId?.toString() || "",
        "invoice-option": "NoInvoice",
      });

      // Apply TLD-specific registration parameters from the central policy
      // registry (T&C acceptance for new gTLDs + any user-provided attributes
      // like .us Nexus or .pro profession collected at checkout).
      // Restricted ccTLDs (au/uk/ca/de etc.) are blocked upstream at the
      // cart/create-order layer, so no inline placeholder branches here.
      for (const [key, value] of getRegistrationParamPairs(
        domainData.domainName,
        domainData.tldAttributes
      )) {
        params.append(key, value);
      }

      // Add each ns param separately using append() method
      nameServers.forEach((ns) => {
        params.append("ns", ns);
      });

      const response = await api.post("/api/domains/register.json", params);

      const responseTime = Date.now() - startTime;

      // Check if the response contains an error status or error message
      const hasError =
        response.data &&
        (response.data.status === "error" || response.data.error);

      if (hasError) {
        serverLogger.error(
          `❌ [PRODUCTION] Domain registration failed for "${domainData.domainName}" in ${responseTime}ms:`,
          {
            responseData: response.data,
            status: response.status,
          }
        );

        // Log the actual ResellerClub error response for debugging
        serverLogger.info(
          `🔍 [PRODUCTION] ResellerClub error response for "${domainData.domainName}":`,
          {
            error: response.data.error,
            fullResponse: response.data,
            status: response.status,
          }
        );

        const errorMessage =
          response.data.error || "Domain registration failed";

        // Check for various error conditions that indicate pending status
        const isPendingStatus =
          errorMessage &&
          (errorMessage.toLowerCase().includes("insufficient balance") ||
            errorMessage.toLowerCase().includes("low funds") ||
            errorMessage.toLowerCase().includes("insufficient funds") ||
            errorMessage.toLowerCase().includes("account balance") ||
            errorMessage.toLowerCase().includes("credit limit") ||
            errorMessage
              .toLowerCase()
              .includes("order locked for processing") ||
            errorMessage.toLowerCase().includes("please contact support") ||
            errorMessage.toLowerCase().includes("locked for processing") ||
            errorMessage.toLowerCase().includes("processing") ||
            errorMessage
              .toLowerCase()
              .includes("already exists in our database") ||
            errorMessage.toLowerCase().includes("pending order") ||
            errorMessage.toLowerCase().includes("pending order for") ||
            response.data.status === "InvoicePaid"); // InvoicePaid with error message indicates pending

        // If this looks like a registry-policy error (T&C, eligibility,
        // minimum period, contact validation), surface a clearer message
        // to the caller alongside the raw error for logs.
        const friendly = mapRegistrationError(errorMessage);
        return {
          status: isPendingStatus ? "pending" : "error",
          message: friendly ?? errorMessage,
          data: response.data, // Include full response data for debugging
        };
      }

      serverLogger.info(
        `✅ [PRODUCTION] Domain registration successful for "${domainData.domainName}" in ${responseTime}ms:`,
        {
          responseData: response.data,
          status: response.status,
        }
      );

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      serverLogger.error(
        `❌ [PRODUCTION] Domain registration failed for "${domainData.domainName}" after ${responseTime}ms:`,
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          axiosError:
            error instanceof AxiosError
              ? {
                  status: error.response?.status,
                  statusText: error.response?.statusText,
                  data: error.response?.data,
                  code: error.code,
                }
              : undefined,
          domainData: {
            domainName: domainData.domainName,
            years: domainData.years,
            customerId: domainData.customerId,
          },
        }
      );

      // Determine specific error message based on response
      let errorMessage = "Failed to register domain";
      if (error instanceof AxiosError) {
        if (error.response?.status === 401) {
          errorMessage =
            "ResellerClub API authentication failed. Please check API credentials.";
        } else if (error.response?.status === 403) {
          errorMessage =
            "ResellerClub API access forbidden. Please check API permissions.";
        } else if (error.response?.status === 400) {
          errorMessage =
            "Invalid domain registration request. Please check domain data.";
        } else if (error.response?.status === 409) {
          errorMessage =
            "Domain registration conflict. Domain may already be registered.";
        } else if (error.response?.status === 429) {
          errorMessage =
            "ResellerClub API rate limit exceeded. Please try again later.";
        } else if (error.response?.status && error.response.status >= 500) {
          errorMessage =
            "ResellerClub API server error. Please try again later.";
        } else if (error.code === "ECONNABORTED") {
          errorMessage = "ResellerClub API request timeout. Please try again.";
        } else if (
          error.code === "ENOTFOUND" ||
          error.code === "ECONNREFUSED"
        ) {
          errorMessage =
            "ResellerClub API connection failed. Please check network connectivity.";
        }
      }

      return {
        status: "error",
        message: errorMessage,
        data: error instanceof AxiosError ? error.response?.data : undefined,
      };
    }
  }

  /**
   * Get domain details
   */
  static async getDomainDetails(
    domainName: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.get("/api/domains/details.json", {
        params: {
          "domain-name": domainName,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub domain details error:", error);
      return {
        status: "error",
        message: "Failed to get domain details",
      };
    }
  }

  /**
   * Activate DNS management for a domain
   */
  static async activateDNSManagement(
    domainName: string,
    orderId: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/activate.json", null, {
        params: {
          "domain-name": domainName,
          "order-id": orderId,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error: any) {
      serverLogger.error("ResellerClub DNS activation error:", error);
      return {
        status: "error",
        message: "Failed to activate DNS management",
      };
    }
  }

  /**
   * Get DNS records for a domain
   * Uses the correct ResellerClub DNS search endpoint
   */
  static async getDNSRecords(
    domainName: string,
    customerId: string
  ): Promise<ResellerClubResponse> {
    try {
      // Search for all record types
      const recordTypes = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV"];
      const allRecords = [];

      for (const recordType of recordTypes) {
        try {
          const response = await api.get(
            "/api/dns/manage/search-records.json",
            {
              params: {
                "domain-name": domainName,
                "customer-id": customerId,
                type: recordType,
                "no-of-records": 50, // Maximum allowed by ResellerClub
                "page-no": 1, // Required parameter for pagination
              },
            }
          );

          if (response.data) {
            // ResellerClub returns records as numbered keys (1, 2, 3, etc.)
            const records = Object.keys(response.data)
              .filter((key) => key !== "recsonpage" && key !== "recsindb")
              .map((key) => {
                const record = response.data[key];
                if (record && record.type) {
                  return {
                    ...record,
                    id:
                      (record as any).recordid ||
                      (record as any).recordId ||
                      (record as any)["record-id"] ||
                      key,
                    ttl: (record as any).timetolive || (record as any).ttl,
                    name: (record as any).host || (record as any).name,
                    priority: (record as any).priority || undefined,
                  };
                }
                return null;
              })
              .filter((record) => record !== null);

            if (records.length > 0) {
              allRecords.push(...records);
            }
          }
        } catch (typeError) {
          // Continue with other record types if one fails
          serverLogger.info(`No ${recordType} records found for ${domainName}`);
        }
      }

      return {
        status: "success",
        data: {
          records: allRecords,
          total: allRecords.length,
        },
      };
    } catch (error: any) {
      serverLogger.error("ResellerClub DNS records error:", error);
      return {
        status: "error",
        message:
          error.response?.status === 404
            ? "Request failed with status code 404"
            : "Failed to get DNS records",
      };
    }
  }

  /**
   * Add DNS record using the correct endpoint based on record type
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
    try {
      // Ensure TTL is at least 7200 (ResellerClub requirement)
      const ttl = Math.max(recordData.ttl, 7200);

      // Normalize host: if '@', use domain name, otherwise use the host name
      const host = recordData.name === "@" ? domainName : recordData.name;

      let endpoint = "";
      let params: any = {
        "domain-name": domainName,
        "customer-id": customerId,
        host: host,
        value: recordData.value,
        ttl: ttl,
      };

      // Use specific endpoint based on record type
      switch (recordData.type.toUpperCase()) {
        case "A":
          endpoint = "/api/dns/manage/add-ipv4-record.json";
          break;
        case "AAAA":
          endpoint = "/api/dns/manage/add-ipv6-record.json";
          break;
        case "CNAME":
          endpoint = "/api/dns/manage/add-cname-record.json";
          break;
        case "MX":
          endpoint = "/api/dns/manage/add-mx-record.json";
          params.priority = recordData.priority || 10;
          break;
        case "NS":
          endpoint = "/api/dns/manage/add-ns-record.json";
          break;
        case "TXT":
          endpoint = "/api/dns/manage/add-txt-record.json";
          break;
        case "SRV":
          endpoint = "/api/dns/manage/add-srv-record.json";
          params.priority = recordData.priority || 10;
          params.weight = 10; // Default weight
          params.port = 443; // Default port
          break;
        default:
          return {
            status: "error",
            message: `Unsupported DNS record type: ${recordData.type}`,
          };
      }

      const response = await api.post(endpoint, null, { params });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error: any) {
      serverLogger.error("ResellerClub add DNS record error:", error);
      return {
        status: "error",
        message: error.response?.data?.msg || "Failed to add DNS record",
      };
    }
  }

  /**
   * Update DNS record
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
    try {
      const response = await api.post(
        "/api/dns/manage/modify-record.json",
        null,
        {
          params: {
            "domain-name": domainName,
            "record-id": recordId,
            type: recordData.type,
            host: recordData.name === "@" ? domainName : recordData.name,
            value: recordData.value,
            ttl: recordData.ttl,
            priority: recordData.priority,
          },
        }
      );

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub update DNS record error:", error);
      return {
        status: "error",
        message: "Failed to update DNS record",
      };
    }
  }

  /**
   * Delete DNS record
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
    try {
      const response = await api.post(
        "/api/dns/manage/delete-record.json",
        null,
        {
          params: {
            "domain-name": domainName,
            "record-id": recordId,
            host: recordData.name,
            value: recordData.value,
            type: recordData.type,
          },
        }
      );

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub delete DNS record error:", error);
      return {
        status: "error",
        message: "Failed to delete DNS record",
      };
    }
  }

  /**
   * Set default nameservers
   */
  static async setDefaultNameservers(
    orderId: string
  ): Promise<ResellerClubResponse> {
    try {
      // ResellerClub doesn't have a specific "use default" endpoint for existing domains via API
      // We must explicitly set them. These are the standard OrderBox nameservers.
      const defaultNameservers = [
        "deepak1299294.mercury.orderbox-dns.com",
        "deepak1299294.venus.orderbox-dns.com",
        "deepak1299294.earth.orderbox-dns.com",
        "deepak1299294.mars.orderbox-dns.com"
      ];

      return await this.setCustomNameservers(orderId, defaultNameservers);
    } catch (error) {
      const err: any = error;
      const apiMsg = err?.response?.data?.msg || err?.response?.data?.message || err?.message;
      serverLogger.error("ResellerClub set default nameservers error:", apiMsg || error);
      return {
        status: "error",
        message: apiMsg || "Failed to set default nameservers",
      };
    }
  }

  /**
   * Set custom nameservers
   */
  static async setCustomNameservers(
    orderId: string,
    nameservers: string[]
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/domains/modify-ns.json", null, {
        params: {
          "order-id": orderId,
          ns: nameservers,
        },
        paramsSerializer: (params) => {
          const searchParams = new URLSearchParams();
          Object.keys(params).forEach((key) => {
            const value = params[key];
            if (Array.isArray(value)) {
              value.forEach((val) => searchParams.append(key, val));
            } else {
              searchParams.append(key, value);
            }
          });
          return searchParams.toString();
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      const err: any = error;
      const apiMsg = err?.response?.data?.msg || err?.response?.data?.message || err?.message;
      serverLogger.error("ResellerClub set custom nameservers error:", apiMsg || error);
      return {
        status: "error",
        message: apiMsg || "Failed to set custom nameservers",
      };
    }
  }

  /**
   * Get customer details
   */
  static async getCustomerDetails(
    username: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.get("/api/customers/details.json", {
        params: {
          username: username,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub customer details error:", error);
      return {
        status: "error",
        message: "Failed to get customer details",
      };
    }
  }

  /**
   * Get domain renewal pricing
   */
  static async getRenewalPricing(
    domainName: string,
    years: number
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.get("/api/domains/renewal-price.json", {
        params: {
          "domain-name": domainName,
          years: years,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub renewal pricing error:", error);
      return {
        status: "error",
        message: "Failed to get renewal pricing",
      };
    }
  }

  /**
   * Renew an existing domain registration.
   *
   * @param orderId  - ResellerClub order-id for the domain
   * @param years    - Number of years to extend registration (1-10)
   * @param expDate  - Current expiry as a Unix timestamp (seconds); obtained from domain details
   */
  static async renewDomain(
    orderId: string,
    years: number,
    expDate: number
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/domains/renew.json", null, {
        params: {
          "order-id": orderId,
          years,
          "exp-date": expDate,
          "invoice-option": "NoInvoice",
        },
      });

      serverLogger.info(
        `[RC-API] Domain renewal submitted for order ${orderId}: ${years} year(s)`,
        response.data
      );

      return {
        status: "success",
        data: response.data,
      };
    } catch (error: any) {
      const msg =
        error?.response?.data?.message ||
        error?.response?.data ||
        error?.message ||
        "Failed to renew domain";
      serverLogger.error(`[RC-API] Domain renewal error for order ${orderId}:`, msg);
      return {
        status: "error",
        message: typeof msg === "string" ? msg : JSON.stringify(msg),
      };
    }
  }

  /**
   * Get domain expiry date
   */
  static async getDomainExpiry(
    domainName: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.get("/api/domains/details.json", {
        params: {
          "domain-name": domainName,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub domain expiry error:", error);
      return {
        status: "error",
        message: "Failed to get domain expiry",
      };
    }
  }

  /**
   * Transfer a domain
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
    try {
      const params: any = {
        "domain-name": domainName,
        "auth-code": authCode,
        "customer-id": customerId,
        "invoice-option": "NoInvoice"
      };
      
      if (contacts) {
        params["reg-contact-id"] = contacts.admin;
        params["admin-contact-id"] = contacts.admin;
        params["tech-contact-id"] = contacts.tech;
        params["billing-contact-id"] = contacts.billing;
      }

      const response = await api.post("/api/domains/transfer.json", null, {
        params
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub domain transfer error:", error);
      return {
        status: "error",
        message: "Failed to transfer domain",
      };
    }
  }

  /**
   * Get all domains for a customer from ResellerClub
   * 
   * Fetches all domain orders associated with a customer account.
   * Used for syncing existing domains into the application.
   * 
   * @param customerId - The ResellerClub customer ID
   * @returns Promise with domain list or error
   */
  static async getCustomerDomains(
    customerId: number
  ): Promise<ResellerClubResponse> {
    const startTime = Date.now();
    serverLogger.info(
      `🔍 [PRODUCTION] Fetching domains for customer ID: ${customerId}`
    );

    try {
      const response = await api.get("/api/domains/search.json", {
        params: {
          "customer-id": customerId,
          "no-of-records": 500, // Fetch up to 500 domains
          "page-no": 1,
        },
      });

      const responseTime = Date.now() - startTime;
      serverLogger.info(
        `✅ [PRODUCTION] Customer domains fetched in ${responseTime}ms:`,
        {
          customerId,
          domainCount: Object.keys(response.data || {}).length,
        }
      );

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      serverLogger.error(
        `❌ [PRODUCTION] Failed to fetch customer domains after ${responseTime}ms:`,
        error
      );
      return {
        status: "error",
        message: "Failed to fetch customer domains",
      };
    }
  }

  /**
   * Get order ID for a specific domain
   * 
   * Retrieves the order ID associated with a domain name.
   * Required for domain management operations.
   * 
   * @param domainName - The domain name to look up
   * @returns Promise with order ID or error
   */
  static async getDomainOrderId(
    domainName: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.get("/api/domains/orderid.json", {
        params: {
          "domain-name": domainName,
        },
      });

      serverLogger.info(
        `✅ [PRODUCTION] Order ID fetched for domain ${domainName}:`,
        response.data
      );

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error(
        `❌ [PRODUCTION] Failed to fetch order ID for ${domainName}:`,
        error
      );
      return {
        status: "error",
        message: "Failed to fetch domain order ID",
      };
    }
  }
  /**
   * Get nameservers for a domain
   */
  static async getNameservers(domainName: string): Promise<string[]> {
    try {
      // First get the order ID
      const orderIdResponse = await this.getDomainOrderId(domainName);
      if (orderIdResponse.status !== "success" || !orderIdResponse.data) {
        serverLogger.error(`❌ [PRODUCTION] Failed to get order ID for nameservers lookup: ${domainName}`);
        return [];
      }
      const orderId = orderIdResponse.data;

      // Get domain details using order ID
      // We need to pass "NsDetails" as an option to ensure we get nameservers
      const response = await api.get("/api/domains/details.json", {
        params: {
          "order-id": orderId,
          "options": "NsDetails"
        },
      });

      if (response.data) {
        serverLogger.info(`🔍 [PRODUCTION] Domain details response for ${domainName}:`, JSON.stringify(response.data, null, 2));
        const ns: string[] = [];
        // ResellerClub returns ns1, ns2, etc. up to ns13 usually
        for (let i = 1; i <= 13; i++) {
            if (response.data[`ns${i}`]) {
                ns.push(response.data[`ns${i}`]);
            }
        }
        
        serverLogger.info(`✅ [PRODUCTION] Found ${ns.length} nameservers for ${domainName} via API:`, ns);
        return ns;
      }
      return [];
    } catch (error) {
      serverLogger.error("ResellerClub get nameservers error:", error);
      return [];
    }
  }
}
