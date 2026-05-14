/**
 * Pricing Service for Domain Management
 *
 * This service handles all pricing-related operations for domains, including
 * fetching live pricing data from ResellerClub API, caching, and providing
 * both customer and reseller pricing information.
 *
 * Key Features:
 * - Live pricing data from ResellerClub API
 * - Intelligent caching with 5-minute TTL
 * - Customer and reseller pricing comparison
 * - TLD-specific pricing lookup
 * - Comprehensive error handling
 *
 * @author Anutech Digital Private Limited
 * @version 2.0.0
 * @since 2024
 */

import axios from "axios";
import { ResellerClubResponse, DomainSearchResult } from "./types";
import { SettingsService } from "./settings-service";
import { redisCache } from "@/lib/redis";
import { tldMappings } from "./tld-mappings";
import { serverLogger } from "@/lib/server-logger";

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

// Configure Axios instance for pricing API requests
const api = axios.create({
  baseURL: RESELLERCLUB_API_URL,
  timeout: 30000, // 30 second timeout
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

// Add authentication to all pricing API requests
api.interceptors.request.use(
  (config) => {
    config.params = {
      ...config.params,
      "auth-userid": RESELLERCLUB_ID,
      "api-key": RESELLERCLUB_SECRET,
      "reseller-id": RESELLERCLUB_ID, // Use same ID for Indian pricing
    };
    return config;
  },
  (error) => {
    serverLogger.error("❌ ResellerClub Pricing API Request Error:", error);
    return Promise.reject(error);
  }
);

const PRICING_CACHE_KEY = "pricing:domain:raw";
const PRICING_CACHE_TTL_S = 30 * 60; // 30 minutes

/**
 * Pricing Service Class
 *
 * Provides methods for fetching and managing domain pricing data.
 * Caches full pricing data in Redis (30-min TTL). Falls back to stale cache
 * when ResellerClub is unreachable.
 */
export class PricingService {
  /**
   * Get domain pricing data
   *
   * Returns cached pricing when available. Fetches live data on cache miss.
   * Falls back to stale cache if ResellerClub API is down.
   *
   * @returns {Promise<any>} Object containing customerPricing and resellerPricing data
   * @throws {Error} If API request fails or data is invalid
   *
   * @example
   * const pricing = await PricingService.getDomainPricing();
   * console.log(pricing.customerPricing); // Customer pricing data
   * console.log(pricing.resellerPricing); // Reseller pricing data
   */
  static async getDomainPricing(): Promise<any> {
    // 1. Cache read
    const cached = await redisCache.get<any>(PRICING_CACHE_KEY);
    if (cached) {
      return cached;
    }

    // 2. Cache miss — fetch from API
    try {
      const [customerPricingResponse, resellerPricingResponse] =
        await Promise.all([
          api.get("/api/products/customer-price.json"),
          api.get("/api/products/reseller-price.json"),
        ]);

      const pricingData = {
        customerPricing: customerPricingResponse.data,
        resellerPricing: resellerPricingResponse.data,
        timestamp: new Date().toISOString(),
      };

      // Store fresh data — also keep a stale fallback with no TTL
      await Promise.all([
        redisCache.set(PRICING_CACHE_KEY, pricingData, PRICING_CACHE_TTL_S),
        redisCache.set(`${PRICING_CACHE_KEY}:stale`, pricingData, 0),
      ]);

      return pricingData;
    } catch (error) {
      // 3. API down — try stale fallback
      const stale = await redisCache.get<any>(`${PRICING_CACHE_KEY}:stale`);
      if (stale) {
        serverLogger.warn(`⚠️ [PRICING] ResellerClub unreachable — returning stale cache from ${stale.timestamp}`);
        return { ...stale, stale: true };
      }
      serverLogger.error(`❌ [PRICING] Failed to fetch domain pricing:`, error);
      throw new Error("Failed to fetch live domain pricing from ResellerClub API");
    }
  }

  /**
   * Get pricing for specific TLDs
   *
   * Retrieves both customer and reseller pricing for multiple TLDs.
   * This method is used by the domain search functionality to get live pricing.
   *
   * @param {string[]} tlds - Array of TLDs to get pricing for (e.g., ['com', 'net', 'org'])
   * @returns {Promise<{ [tld: string]: any }>} Object containing pricing data for each TLD
   *
   * @example
   * const pricing = await PricingService.getTLDPricing(['com', 'net', 'org']);
   * console.log(pricing.com.price); // Customer price for .com
   * console.log(pricing.com.resellerPrice); // Reseller price for .com
   */
  static async getTLDPricing(tlds: string[]): Promise<{ [tld: string]: any }> {
    const startTime = Date.now();

    try {
      const pricingData = await this.getDomainPricing();
      const tldPricing: { [tld: string]: any } = {};

      // Check if pricing data is available
      if (!pricingData || !pricingData.customerPricing) {
        return tldPricing;
      }

      // Extract pricing for requested TLDs
      for (const tld of tlds) {
        const cleanTld = tld.startsWith(".") ? tld.substring(1) : tld;

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
          // Special handling for multi-level TLDs
          cleanTld === "co.in" ? "thirdleveldotin" : null,
          cleanTld === "co.uk" ? "thirdleveldotuk" : null,
          cleanTld === "co.ca" ? "thirdleveldotca" : null,
          cleanTld === "co.au" ? "thirdleveldotau" : null,
          cleanTld === "co.za" ? "thirdleveldotza" : null,
          cleanTld === "co.nz" ? "thirdleveldotnz" : null,
          // Handle other common multi-level TLDs
          cleanTld.includes(".")
            ? `thirdleveldot${cleanTld.split(".").pop()}`
            : null,
          // CentralNic formats (lower priority)
          `centralnicza${cleanTld}`,
          `centralnicus${cleanTld}`,
          // domcno is often used for .com, .net, and .org bundled together
          (cleanTld === 'net' || cleanTld === 'org') ? 'domcno' : null,
        ].filter(Boolean); // Remove null values
        let foundTld = null;

        for (const variation of tldVariations) {
          if (
            variation &&
            pricingData.customerPricing &&
            pricingData.customerPricing[variation]
          ) {
            foundTld = variation;
            break;
          }
        }

        if (!foundTld) {
          serverLogger.warn(`⚠️ [PRICING] No pricing found for TLD: ${cleanTld}. Variations tried: ${tldVariations.join(', ')}`);
        }

        if (foundTld) {
          const customerPricing = pricingData.customerPricing?.[foundTld];
          const resellerPricing =
            pricingData.resellerPricing?.[foundTld] || null;

          // Extract customer registration price (try 1 year first, then 2 years)
          let customerPrice = 0;
          let currency = "INR";
          let registrationPeriod = 1;

          if (
            customerPricing.addnewdomain &&
            customerPricing.addnewdomain["1"]
          ) {
            customerPrice = parseFloat(customerPricing.addnewdomain["1"]);
            registrationPeriod = 1;
          } else if (
            customerPricing.addnewdomain &&
            customerPricing.addnewdomain["2"]
          ) {
            customerPrice = parseFloat(customerPricing.addnewdomain["2"]);
            registrationPeriod = 2;
          }

          // Extract reseller registration price (try 1 year first, then 2 years)
          let resellerPrice = 0;
          if (
            resellerPricing &&
            resellerPricing.addnewdomain &&
            resellerPricing.addnewdomain["1"]
          ) {
            resellerPrice = parseFloat(resellerPricing.addnewdomain["1"]);
          } else if (
            resellerPricing &&
            resellerPricing.addnewdomain &&
            resellerPricing.addnewdomain["2"]
          ) {
            resellerPrice = parseFloat(resellerPricing.addnewdomain["2"]);
          }

          tldPricing[cleanTld] = {
            price: customerPrice,
            resellerPrice: resellerPrice,
            currency: currency,
            registrationPeriod: registrationPeriod,
            customer: customerPricing,
            reseller: resellerPricing,
            tld: cleanTld,
          };

          const margin =
            customerPrice > 0 && resellerPrice > 0
              ? ((customerPrice - resellerPrice) / customerPrice) * 100
              : 0;

          // Individual TLD logging removed for cleaner output
        }
      }

      // Summary logging
      const totalTlds = Object.keys(tldPricing).length;
      const totalCustomerPrice = Object.values(tldPricing).reduce(
        (sum, tld) => sum + (tld.price || 0),
        0
      );



      return tldPricing;
    } catch (error) {
      serverLogger.error(`❌ [PRICING] Failed to fetch TLD pricing:`, error);
      throw error;
    }
  }

  /**
   * Get registration price for a specific TLD
   */
  static async getRegistrationPrice(
    tld: string,
    years: number = 1
  ): Promise<{ price: number; currency: string } | null> {
    try {
      const cleanTld = tld.startsWith(".") ? tld.substring(1) : tld;
      const tldPricing = await this.getTLDPricing([cleanTld]);

      if (tldPricing[cleanTld] && tldPricing[cleanTld].customer) {
        const customerPricing = tldPricing[cleanTld].customer;

        // Get registration price (addnewdomain) for specified years
        if (
          customerPricing.addnewdomain &&
          customerPricing.addnewdomain[years.toString()]
        ) {
          const price = parseFloat(
            customerPricing.addnewdomain[years.toString()]
          );
          return {
            price: price,
            currency: "INR", // ResellerClub typically returns prices in INR
          };
        }
      }

      return null;
    } catch (error) {
      serverLogger.error(
        `❌ [PRICING] Failed to get registration price for ${tld}:`,
        error
      );
      return null;
    }
  }

  /**
   * Get renewal price for a specific TLD
   */
  static async getRenewalPrice(
    tld: string,
    years: number = 1
  ): Promise<{ price: number; currency: string } | null> {
    try {
      const cleanTld = tld.startsWith(".") ? tld.substring(1) : tld;
      const tldPricing = await this.getTLDPricing([cleanTld]);

      if (tldPricing[cleanTld] && tldPricing[cleanTld].customer) {
        const customerPricing = tldPricing[cleanTld].customer;

        // Get renewal price (renewdomain) for specified years
        if (
          customerPricing.renewdomain &&
          customerPricing.renewdomain[years.toString()]
        ) {
          const price = parseFloat(
            customerPricing.renewdomain[years.toString()]
          );
          return {
            price: price,
            currency: "INR",
          };
        }
      }

      return null;
    } catch (error) {
      serverLogger.error(
        `❌ [PRICING] Failed to get renewal price for ${tld}:`,
        error
      );
      return null;
    }
  }

  /**
   * Get transfer price for a specific TLD
   */
  static async getTransferPrice(
    tld: string,
    years: number = 1
  ): Promise<{ price: number; currency: string } | null> {
    try {
      const cleanTld = tld.startsWith(".") ? tld.substring(1) : tld;
      const tldPricing = await this.getTLDPricing([cleanTld]);

      if (tldPricing[cleanTld] && tldPricing[cleanTld].customer) {
        const customerPricing = tldPricing[cleanTld].customer;

        // Get transfer price (addtransferdomain) for specified years
        if (
          customerPricing.addtransferdomain &&
          customerPricing.addtransferdomain[years.toString()]
        ) {
          const price = parseFloat(
            customerPricing.addtransferdomain[years.toString()]
          );
          return {
            price: price,
            currency: "INR",
          };
        }
      }

      return null;
    } catch (error) {
      serverLogger.error(
        `❌ [PRICING] Failed to get transfer price for ${tld}:`,
        error
      );
      return null;
    }
  }

  /**
   * Clear pricing cache (no-op since caching is disabled)
   */
  static clearCache(): void {
    // No caching - nothing to clear
    serverLogger.info(`💰 [PRICING] Cache clear requested (no caching enabled)`);
  }
}
