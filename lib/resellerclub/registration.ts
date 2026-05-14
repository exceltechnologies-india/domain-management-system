/**
 * ResellerClub — registration + domain lifecycle.
 */

import { AxiosError } from "axios";
import { ResellerClubResponse } from "@/lib/types";
import { serverLogger } from "@/lib/server-logger";
import { getRegistrationParamPairs, mapRegistrationError } from "@/lib/tld-policies";
import { api } from "./client";

/**
 * Delete or Cancel a domain registration order
 * This is used for cancelling orders stuck in "Processing" or within grace period
 */
export async function deleteDomainOrder(orderId: string): Promise<ResellerClubResponse> {
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
export async function registerDomain(domainData: {
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
export async function getDomainDetails(
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
 * Get domain expiry date
 */
export async function getDomainExpiry(
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
 * Get order ID for a specific domain
 *
 * Retrieves the order ID associated with a domain name.
 * Required for domain management operations.
 *
 * @param domainName - The domain name to look up
 * @returns Promise with order ID or error
 */
export async function getDomainOrderId(
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
