/**
 * ResellerClub — renewal + transfer.
 */

import { ResellerClubResponse } from "@/lib/types";
import { serverLogger } from "@/lib/server-logger";
import { api } from "./client";

/**
 * Get domain renewal pricing
 */
export async function getRenewalPricing(
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
export async function renewDomain(
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
  } catch (error: unknown) {
    const err = error as { response?: { data?: { message?: string } | string }; message?: string };
    const msg =
      (typeof err.response?.data === "object" ? err.response?.data?.message : err.response?.data) ||
      err.message ||
      "Failed to renew domain";
    serverLogger.error(`[RC-API] Domain renewal error for order ${orderId}:`, msg);
    return {
      status: "error",
      message: typeof msg === "string" ? msg : JSON.stringify(msg),
    };
  }
}

/**
 * Transfer a domain
 */
export async function transferDomain(
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
    const params: Record<string, string | number> = {
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
