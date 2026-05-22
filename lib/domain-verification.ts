/**
 * Domain Verification Service
 *
 * This service provides functionality to verify domain registration status
 * by checking domain availability after registration attempts.
 *
 * Since ResellerClub API doesn't provide reliable wallet balance information
 * or proper error responses for insufficient funds, we use this workaround:
 * - After attempting domain registration, check if domain is still available
 * - If domain is still available, it likely means registration failed due to insufficient funds
 * - This allows us to detect pending registrations that need manual intervention
 */

import { ResellerClubWrapper } from "./resellerclub-wrapper";
import Domain from "@/models/Domain";
import { type IOrder } from "@/models/Order";
import { findOrdersByDomainName } from "@/lib/services/orders";
import { serverLogger } from "@/lib/server-logger";

export interface DomainVerificationResult {
  domainName: string;
  isAvailable: boolean;
  registrationStatus: "success" | "pending" | "failed";
  reason?: string;
  checkedAt: Date;
}

export class DomainVerificationService {
  /**
   * Sync a domain's status and details with ResellerClub registrar
   * 
   * @param domainName - The domain name to sync
   * @returns Successful sync result or error
   */
  static async syncDomainWithRegistrar(domainName: string) {
    try {
      serverLogger.info(`🔄 [DOMAIN-SYNC] Starting registrar sync for: ${domainName}`);
      
      // 1. Get ResellerClub Order ID
      const orderIdResponse = await ResellerClubWrapper.getDomainOrderId(domainName);
      
      if (orderIdResponse.status !== "success" || !orderIdResponse.data) {
        serverLogger.warn(`⚠️ [DOMAIN-SYNC] No ResellerClub order found for ${domainName}`);
        return {
          success: false,
          error: "No active order found at registrar for this domain.",
        };
      }
      
      const resellerClubOrderId = orderIdResponse.data;
      
      // 2. Get Full Domain Details
      const detailsResult = await ResellerClubWrapper.getDomainDetails(domainName);
      
      if (detailsResult.status !== "success" || !detailsResult.data) {
        return {
          success: false,
          error: "Failed to fetch domain details from registrar.",
        };
      }
      
      const details = detailsResult.data;
      const expiresAt = new Date(parseInt(details.endtime) * 1000);
      const registeredAt = new Date(parseInt(details.creationtime) * 1000);

      // Map ResellerClub currentstatus to our local status using an allowlist.
      // ONLY "Active" (case-insensitive) from ResellerClub means the domain is
      // fully registered. Any other value — including statuses like "Processing",
      // "Locked for processing", "Pending Verification", "InvoicePaid", "Suspended",
      // or unknown future values — is treated as "pending" so admin review is required.
      // This prevents prematurely marking a domain as "registered" when ResellerClub
      // accepted the order but couldn't process it due to insufficient funds.
      const rcStatus = (details.currentstatus ?? "").toLowerCase().trim();
      let localStatus: "registered" | "pending" | "failed";
      if (rcStatus === "active") {
        localStatus = "registered";
      } else if (
        rcStatus.includes("deleted") ||
        rcStatus.includes("expired") ||
        rcStatus.includes("redemption") ||
        rcStatus.includes("grace period") ||
        rcStatus === "rgp"
      ) {
        localStatus = "failed";
      } else {
        // suspended, pending, inactive, processing, locked, invoicepaid,
        // transferring, unknown, or empty → require explicit admin confirmation
        localStatus = "pending";
        serverLogger.info(
          `⚠️ [DOMAIN-SYNC] Non-active status from RC for ${domainName}: "${details.currentstatus}" → keeping as pending`
        );
      }

      // 3. Update Domain Collection.
      // Guard: never downgrade a domain that is already "registered" back to "pending"
      // via sync. If RC returns an ambiguous status but we already confirmed the
      // domain, trust the local record. Only allow "registered" → "pending" if the
      // new status is "failed" (expired / deleted at registrar).
      const domainQuery: Record<string, any> = { domainName: domainName.toLowerCase().trim() };
      if (localStatus === "pending") {
        // Do not overwrite a locally confirmed "registered" status with "pending"
        domainQuery.status = { $ne: "registered" };
      }

      const updatedDomain = await Domain.findOneAndUpdate(
        domainQuery,
        {
          $set: {
            status: localStatus,
            expiresAt: expiresAt,
            registeredAt: registeredAt,
            resellerClubOrderId: resellerClubOrderId,
            nameservers: details.ns,
          }
        },
        { new: true }
      );
      
      if (updatedDomain) {
        serverLogger.info(`✅ [DOMAIN-SYNC] Updated Domain record for: ${domainName}`);
      }

      // 4. Update Order Collection (Sync any matching domain entries in orders)
      const orders = await findOrdersByDomainName(domainName.toLowerCase().trim());
      for (const order of orders) {
        const domainIndex = order.domains.findIndex(
          (d: IOrder['domains'][number]) => d.domainName === domainName.toLowerCase().trim()
        );
        if (domainIndex !== -1) {
          const currentOrderDomainStatus = order.domains[domainIndex].status;
          // Same guard: do not overwrite a confirmed "registered" status with "pending"
          if (localStatus === "pending" && currentOrderDomainStatus === "registered") {
            serverLogger.info(
              `⚠️ [DOMAIN-SYNC] Skipping Order status downgrade for ${domainName} (already registered)`
            );
          } else {
            order.domains[domainIndex].status = localStatus;
          }
          order.domains[domainIndex].expiresAt = expiresAt;
          order.domains[domainIndex].resellerClubOrderId = resellerClubOrderId;
          order.markModified("domains");
          await order.save();
          serverLogger.info(`✅ [DOMAIN-SYNC] Updated Order ${order.orderId} for: ${domainName}`);
        }
      }

      return {
        success: true,
        domainName,
        resellerClubOrderId,
        expiresAt,
        status: localStatus,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error occurred during registrar sync.";
      serverLogger.error(`❌ [DOMAIN-SYNC] Error syncing ${domainName}:`, error);
      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * Verify if a domain registration was successful by checking availability
   *
   * @param domainName - The domain name to verify
   * @returns Promise<DomainVerificationResult>
   */
  static async verifyDomainRegistration(
    domainName: string
  ): Promise<DomainVerificationResult> {

    try {
      // Parse domain name to get base domain and TLD
      const domainParts = domainName.split(".");
      const baseDomain = domainParts[0];
      const tld = domainParts.slice(1).join(".");

      // Search for the domain using the base domain and TLD
      const searchResults = await ResellerClubWrapper.searchDomainWithTlds(
        baseDomain,
        [tld]
      );

      // Find the exact domain in search results
      const domainResult = searchResults.find(
        (result) => result.domainName.toLowerCase() === domainName.toLowerCase()
      );

      if (!domainResult) {
        // If domain is not found in search results, it could mean:
        // 1. Domain is registered (not available for search)
        // 2. Domain search failed or returned unexpected results
        // 3. Domain search API returned different format

        // Check if any search results contain our domain name (partial match)
        const partialMatch = searchResults.find(
          (result) =>
            result.domainName
              .toLowerCase()
              .includes(domainName.toLowerCase()) ||
            domainName.toLowerCase().includes(result.domainName.toLowerCase())
        );

        if (partialMatch) {
          // Use the partial match result
          const isAvailable = partialMatch.available;
          return {
            domainName,
            isAvailable,
            registrationStatus: isAvailable ? "pending" : "pending", // Conservative: even if not available, might be pending at registrar
            reason: isAvailable
              ? "Domain still available - registration likely failed due to insufficient funds"
              : "Domain no longer available in search - registration might be pending or successful",
            checkedAt: new Date(),
          };
        }

        // No match found - be conservative and mark as pending for manual verification
        return {
          domainName,
          isAvailable: false,
          registrationStatus: "pending",
          reason:
            "Domain not found in availability search - needs manual verification of order status",
          checkedAt: new Date(),
        };
      }

      const isAvailable = domainResult.available;

      if (isAvailable) {
        return {
          domainName,
          isAvailable: true,
          registrationStatus: "pending",
          reason:
            "Domain still available - registration likely failed due to insufficient funds",
          checkedAt: new Date(),
        };
      } else {
        // If domain is NOT available, it could be a success OR a pending order at ResellerClub
        // We will mark it as 'pending' for manual review to be safe, unless we have an Order ID confirmation.
        return {
          domainName,
          isAvailable: false,
          registrationStatus: "pending", // Changed from "success" to "pending"
          reason: "Domain no longer available - registration might be pending or successful. Manual verification highly recommended.",
          checkedAt: new Date(),
        };
      }
    } catch (error) {
      serverLogger.error(
        `❌ [DOMAIN-VERIFICATION] Error verifying domain ${domainName}:`,
        error
      );
      return {
        domainName,
        isAvailable: false,
        registrationStatus: "failed",
        reason: `Verification failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        checkedAt: new Date(),
      };
    }
  }

  /**
   * Verify multiple domains in batch
   *
   * @param domainNames - Array of domain names to verify
   * @returns Promise<DomainVerificationResult[]>
   */
  static async verifyMultipleDomains(
    domainNames: string[]
  ): Promise<DomainVerificationResult[]> {

    const results: DomainVerificationResult[] = [];

    // Process domains in parallel with a small delay to avoid rate limiting
    const batchSize = 5;
    for (let i = 0; i < domainNames.length; i += batchSize) {
      const batch = domainNames.slice(i, i + batchSize);

      const batchPromises = batch.map(async (domainName) => {
        // Add small delay between requests to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 200));
        return this.verifyDomainRegistration(domainName);
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Add delay between batches
      if (i + batchSize < domainNames.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return results;
  }

  /**
   * Check if a domain verification result indicates a pending registration
   *
   * @param result - Domain verification result
   * @returns boolean
   */
  static isPendingRegistration(result: DomainVerificationResult): boolean {
    // If it's explicitly marked as pending, we should treat it as such 
    // even if isAvailable is false (it could be in a pending order)
    return result.registrationStatus === "pending";
  }

  /**
   * Get summary statistics from verification results
   *
   * @param results - Array of verification results
   * @returns Object with summary statistics
   */
  static getVerificationSummary(results: DomainVerificationResult[]) {
    const summary = {
      total: results.length,
      successful: 0,
      pending: 0,
      failed: 0,
      pendingDomains: [] as string[],
    };

    results.forEach((result) => {
      switch (result.registrationStatus) {
        case "success":
          summary.successful++;
          break;
        case "pending":
          summary.pending++;
          summary.pendingDomains.push(result.domainName);
          break;
        case "failed":
          summary.failed++;
          break;
      }
    });

    return summary;
  }
}
