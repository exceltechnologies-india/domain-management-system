/**
 * ResellerClub — DNS + nameservers.
 */

import { AxiosError } from "axios";
import { ResellerClubResponse } from "@/lib/types";
import { serverLogger } from "@/lib/server-logger";
import { api } from "./client";
import { getDomainOrderId } from "./registration";
import type { RcDnsRecord } from "./types";

/** Narrowing helper for the axios catch sites — pulls the API status code
 *  back out of an AxiosError without leaking `any` into the call site. */
function axiosStatus(err: unknown): number | undefined {
  if (err instanceof AxiosError) return err.response?.status;
  return undefined;
}

/**
 * Activate DNS management for a domain
 */
export async function activateDNSManagement(
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
  } catch (error) {
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
export async function getDNSRecords(
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
              const record = response.data[key] as RcDnsRecord;
              if (record && record.type) {
                return {
                  ...record,
                  id:
                    record.recordid ||
                    record.recordId ||
                    record["record-id"] ||
                    key,
                  ttl: record.timetolive || record.ttl,
                  name: record.host || record.name,
                  priority: record.priority || undefined,
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
  } catch (error) {
    serverLogger.error("ResellerClub DNS records error:", error);
    return {
      status: "error",
      message:
        axiosStatus(error) === 404
          ? "Request failed with status code 404"
          : "Failed to get DNS records",
    };
  }
}

/**
 * Add DNS record using the correct endpoint based on record type
 */
export async function addDNSRecord(
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
    const params: Record<string, string | number> = {
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
  } catch (error) {
    serverLogger.error("ResellerClub add DNS record error:", error);
    const msg =
      error instanceof AxiosError
        ? (error.response?.data as { msg?: string } | undefined)?.msg
        : undefined;
    return {
      status: "error",
      message: msg || "Failed to add DNS record",
    };
  }
}

/**
 * Update DNS record
 */
export async function updateDNSRecord(
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
export async function deleteDNSRecord(
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
export async function setDefaultNameservers(
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

    return await setCustomNameservers(orderId, defaultNameservers);
  } catch (error) {
    const apiMsg =
      error instanceof AxiosError
        ? (error.response?.data as { msg?: string; message?: string } | undefined)?.msg ||
          (error.response?.data as { msg?: string; message?: string } | undefined)?.message ||
          error.message
        : error instanceof Error
        ? error.message
        : undefined;
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
export async function setCustomNameservers(
  orderId: string,
  nameservers: string[]
): Promise<ResellerClubResponse> {
  try {
    const response = await api.post("/api/domains/modify-ns.json", null, {
      params: {
        "order-id": orderId,
        ns: nameservers,
      },
      paramsSerializer: (params: Record<string, unknown>) => {
        const searchParams = new URLSearchParams();
        Object.keys(params).forEach((key) => {
          const value = params[key];
          if (Array.isArray(value)) {
            value.forEach((val) => searchParams.append(key, String(val)));
          } else {
            searchParams.append(key, String(value));
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
    const apiMsg =
      error instanceof AxiosError
        ? (error.response?.data as { msg?: string; message?: string } | undefined)?.msg ||
          (error.response?.data as { msg?: string; message?: string } | undefined)?.message ||
          error.message
        : error instanceof Error
        ? error.message
        : undefined;
    serverLogger.error("ResellerClub set custom nameservers error:", apiMsg || error);
    return {
      status: "error",
      message: apiMsg || "Failed to set custom nameservers",
    };
  }
}

/**
 * Get nameservers for a domain
 */
export async function getNameservers(domainName: string): Promise<string[]> {
  try {
    // First get the order ID
    const orderIdResponse = await getDomainOrderId(domainName);
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
