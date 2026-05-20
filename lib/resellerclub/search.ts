/**
 * ResellerClub — pricing + domain search.
 */

import { AxiosError } from "axios";
import { DomainSearchResult } from "@/lib/types";
import { PricingService } from "@/lib/pricing-service";
import { tldMappings } from "@/lib/tld-mappings";
import { serverLogger } from "@/lib/server-logger";
import { api } from "./client";
import type {
  RcAvailabilityEntry,
  RcAvailabilityResponse,
  RcAvailabilitySearchParams,
  RcDomainPricing,
  RcTldPricing,
  RcTldPricingDetail,
  RcTldPricingPair,
} from "./types";

/**
 * Fetch live domain pricing from ResellerClub API
 *
 * Retrieves both customer and reseller pricing data from ResellerClub API.
 * This method is used by the PricingService to get the latest pricing information.
 *
 * @returns {Promise<RcDomainPricing>} Object containing customerPricing and resellerPricing data
 * @throws {Error} If API request fails or credentials are invalid
 *
 * @example
 * const pricing = await ResellerClubAPI.getDomainPricing();
 * console.log(pricing.customerPricing); // Customer pricing data
 * console.log(pricing.resellerPricing); // Reseller pricing data
 */
export async function getDomainPricing(): Promise<RcDomainPricing> {
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
export async function getTLDPricing(tlds: string[]): Promise<{ [tld: string]: RcTldPricingPair }> {
  const startTime = Date.now();

  try {
    const pricingData = await getDomainPricing();
    const tldPricing: { [tld: string]: RcTldPricingPair } = {};

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
export async function searchDomain(domainName: string): Promise<DomainSearchResult[]> {
  const startTime = Date.now();

  // Check if domain already has a TLD
  const hasTLD = domainName.includes(".");
  const searchParams: RcAvailabilitySearchParams = {
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
      const hasError = Object.values(response.data as RcAvailabilityResponse).some(
        (data) =>
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
          const domainData = data as RcAvailabilityEntry;
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
                  const finalPrice = livePricing[tld].price || 0;
                  const resellerPrice = livePricing[tld].resellerPrice || 0;
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
export async function searchDomainWithTlds(
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
      const hasError = Object.values(response.data as RcAvailabilityResponse).some(
        (data) =>
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
                    price = livePricing[tld].price || 0;
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
          const domainData = data as RcAvailabilityEntry;
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
          let livePricing: { [tld: string]: RcTldPricingDetail } | null = null;

          if (isAvailable && tld) {
            try {
              livePricing = await PricingService.getTLDPricing([tld]);

              if (livePricing && livePricing[tld]) {
                const customerPrice = livePricing[tld].price || 0;
                const resellerPrice =
                  livePricing[tld].resellerPrice || 0;
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
export async function getResellerPricingForTLD(
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
 * @returns {Promise<{status: string, data?: ResellerDetails, error?: string}>} Reseller details with balance information
 * @throws {Error} If API request fails or credentials are invalid
 *
 * @example
 * const result = await ResellerClubAPI.getResellerDetails();
 * if (result.status === 'success') {
 *   console.log('Available Balance:', result.data.availablebalance);
 * }
 */
export async function getResellerDetails(): Promise<{
  status: string;
  data?: {
    resellerid?: string;
    name?: string;
    availablebalance?: string;
    unutilisedsellingbalance?: string;
    lockedbalance?: string;
    billingmode?: string;
    resellerstatus?: string;
    totalreceipts?: string;
    /** Open for fields the upstream API has added since this type was written. */
    [key: string]: string | undefined;
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
  } catch (error) {
    const responseTime = Date.now() - startTime;
    serverLogger.error(
      `❌ [RESELLER] Failed to fetch reseller details in ${responseTime}ms:`,
      error
    );

    // Handle different error scenarios. AxiosError carries `response` /
    // `request`; the type guard keeps the catch typed as `unknown`.
    if (error instanceof AxiosError) {
      if (error.response) {
        return {
          status: "error",
          error:
            (error.response.data as { message?: string; error?: string })?.message ||
            (error.response.data as { message?: string; error?: string })?.error ||
            `API Error: ${error.response.status} ${error.response.statusText}`,
        };
      } else if (error.request) {
        return {
          status: "error",
          error: "No response from ResellerClub API",
        };
      }
    }
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}
