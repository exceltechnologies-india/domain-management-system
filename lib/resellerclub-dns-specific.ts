/**
 * ResellerClub DNS API - Specific Record Type Implementation
 * 
 * Based on ResellerClub Knowledge Base: https://manage.resellerclub.com/kb/answer/1091
 * Each DNS record type requires its own specific API endpoint.
 */

import axios, { AxiosError, AxiosResponse } from "axios";
import { ResellerClubResponse } from "./types";
import { serverLogger } from "./server-logger";

/** Narrows a catch-block error to an HTTP status when the cause was Axios. */
function axiosStatus(err: unknown): number | undefined {
  if (err instanceof AxiosError) return err.response?.status;
  return undefined;
}

// Environment configuration
const RESELLERCLUB_API_URL = process.env.RESELLERCLUB_API_URL;
const RESELLERCLUB_ID = process.env.RESELLERCLUB_ID;
const RESELLERCLUB_SECRET = process.env.RESELLERCLUB_SECRET;

// Configure Axios instance
const api = axios.create({
  baseURL: RESELLERCLUB_API_URL,
  timeout: 30000,
});

// Request interceptor
api.interceptors.request.use(
  (config) => {
    const timestamp = new Date().toISOString();


    // Add authentication parameters
    config.params = {
      ...config.params,
      "auth-userid": RESELLERCLUB_ID,
      "api-key": RESELLERCLUB_SECRET,
    };
    return config;
  },
  (error) => {
    serverLogger.error("❌ ResellerClub DNS API Request Error:", error);
    return Promise.reject(error);
  }
);

// Response interceptor
api.interceptors.response.use(
  (response: AxiosResponse) => {
    return response;
  },
  (error: AxiosError) => {
    const timestamp = new Date().toISOString();
    serverLogger.error(`❌ [${timestamp}] ResellerClub DNS API Error:`, {
      message: error.message,
      status: error.response?.status,
      url: error.config?.url,
      data: error.response?.data,
    });
    return Promise.reject(error);
  }
);

export class ResellerClubDNSSpecific {
  
  // ==================== SEARCHING DNS RECORDS ====================
  
  /**
   * Search DNS Records
   * Endpoint: /api/dns/manage/search-records.json
   */
  static async searchDNSRecords(
    domainName: string,
    customerId: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.get("/api/dns/manage/search-records.json", {
        params: {
          "domain-name": domainName,
          "customer-id": customerId,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub search DNS records error:", error);
      return {
        status: "error",
        message: axiosStatus(error) === 404
          ? "Request failed with status code 404"
          : "Failed to search DNS records",
      };
    }
  }

  // ==================== ADDING DNS RECORDS ====================

  /**
   * Add IPv4 Address Record (A Record)
   * Endpoint: /api/dns/manage/add-ipv4-record.json
   */
  static async addIPv4Record(
    domainName: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/add-ipv4-record.json", null, {
        params: {
          "domain-name": domainName,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub add IPv4 record error:", error);
      return {
        status: "error",
        message: "Failed to add IPv4 record",
      };
    }
  }

  /**
   * Add IPv6 Address Record (AAAA Record)
   * Endpoint: /api/dns/manage/add-ipv6-record.json
   */
  static async addIPv6Record(
    domainName: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/add-ipv6-record.json", null, {
        params: {
          "domain-name": domainName,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub add IPv6 record error:", error);
      return {
        status: "error",
        message: "Failed to add IPv6 record",
      };
    }
  }

  /**
   * Add CNAME Record
   * Endpoint: /api/dns/manage/add-cname-record.json
   */
  static async addCNAMERecord(
    domainName: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/add-cname-record.json", null, {
        params: {
          "domain-name": domainName,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub add CNAME record error:", error);
      return {
        status: "error",
        message: "Failed to add CNAME record",
      };
    }
  }

  /**
   * Add MX Record
   * Endpoint: /api/dns/manage/add-mx-record.json
   */
  static async addMXRecord(
    domainName: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
      priority: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/add-mx-record.json", null, {
        params: {
          "domain-name": domainName,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
          priority: recordData.priority,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub add MX record error:", error);
      return {
        status: "error",
        message: "Failed to add MX record",
      };
    }
  }

  /**
   * Add NS Record
   * Endpoint: /api/dns/manage/add-ns-record.json
   */
  static async addNSRecord(
    domainName: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/add-ns-record.json", null, {
        params: {
          "domain-name": domainName,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub add NS record error:", error);
      return {
        status: "error",
        message: "Failed to add NS record",
      };
    }
  }

  /**
   * Add TXT Record
   * Endpoint: /api/dns/manage/add-txt-record.json
   */
  static async addTXTRecord(
    domainName: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/add-txt-record.json", null, {
        params: {
          "domain-name": domainName,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub add TXT record error:", error);
      return {
        status: "error",
        message: "Failed to add TXT record",
      };
    }
  }

  /**
   * Add SRV Record
   * Endpoint: /api/dns/manage/add-srv-record.json
   */
  static async addSRVRecord(
    domainName: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
      priority: number;
      weight: number;
      port: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/add-srv-record.json", null, {
        params: {
          "domain-name": domainName,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
          priority: recordData.priority,
          weight: recordData.weight,
          port: recordData.port,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub add SRV record error:", error);
      return {
        status: "error",
        message: "Failed to add SRV record",
      };
    }
  }

  // ==================== MODIFYING DNS RECORDS ====================

  /**
   * Modify IPv4 Address Record (A Record)
   * Endpoint: /api/dns/manage/modify-ipv4-record.json
   */
  static async modifyIPv4Record(
    domainName: string,
    recordId: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/modify-ipv4-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub modify IPv4 record error:", error);
      return {
        status: "error",
        message: "Failed to modify IPv4 record",
      };
    }
  }

  /**
   * Modify IPv6 Address Record (AAAA Record)
   * Endpoint: /api/dns/manage/modify-ipv6-record.json
   */
  static async modifyIPv6Record(
    domainName: string,
    recordId: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/modify-ipv6-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub modify IPv6 record error:", error);
      return {
        status: "error",
        message: "Failed to modify IPv6 record",
      };
    }
  }

  /**
   * Modify CNAME Record
   * Endpoint: /api/dns/manage/modify-cname-record.json
   */
  static async modifyCNAMERecord(
    domainName: string,
    recordId: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/modify-cname-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub modify CNAME record error:", error);
      return {
        status: "error",
        message: "Failed to modify CNAME record",
      };
    }
  }

  /**
   * Modify MX Record
   * Endpoint: /api/dns/manage/modify-mx-record.json
   */
  static async modifyMXRecord(
    domainName: string,
    recordId: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
      priority: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/modify-mx-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
          priority: recordData.priority,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub modify MX record error:", error);
      return {
        status: "error",
        message: "Failed to modify MX record",
      };
    }
  }

  /**
   * Modify NS Record
   * Endpoint: /api/dns/manage/modify-ns-record.json
   */
  static async modifyNSRecord(
    domainName: string,
    recordId: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/modify-ns-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub modify NS record error:", error);
      return {
        status: "error",
        message: "Failed to modify NS record",
      };
    }
  }

  /**
   * Modify TXT Record
   * Endpoint: /api/dns/manage/modify-txt-record.json
   */
  static async modifyTXTRecord(
    domainName: string,
    recordId: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/modify-txt-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub modify TXT record error:", error);
      return {
        status: "error",
        message: "Failed to modify TXT record",
      };
    }
  }

  /**
   * Modify SRV Record
   * Endpoint: /api/dns/manage/modify-srv-record.json
   */
  static async modifySRVRecord(
    domainName: string,
    recordId: string,
    recordData: {
      host: string;
      value: string;
      ttl: number;
      priority: number;
      weight: number;
      port: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/modify-srv-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
          host: recordData.host,
          value: recordData.value,
          ttl: recordData.ttl,
          priority: recordData.priority,
          weight: recordData.weight,
          port: recordData.port,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub modify SRV record error:", error);
      return {
        status: "error",
        message: "Failed to modify SRV record",
      };
    }
  }

  /**
   * Modify SOA Record
   * Endpoint: /api/dns/manage/modify-soa-record.json
   */
  static async modifySOARecord(
    domainName: string,
    recordData: {
      ttl: number;
      primary_ns: string;
      resp_person: string;
      serial: number;
      refresh: number;
      retry: number;
      expire: number;
      minimum: number;
    }
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/modify-soa-record.json", null, {
        params: {
          "domain-name": domainName,
          ttl: recordData.ttl,
          primary_ns: recordData.primary_ns,
          resp_person: recordData.resp_person,
          serial: recordData.serial,
          refresh: recordData.refresh,
          retry: recordData.retry,
          expire: recordData.expire,
          minimum: recordData.minimum,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub modify SOA record error:", error);
      return {
        status: "error",
        message: "Failed to modify SOA record",
      };
    }
  }

  // ==================== DELETING DNS RECORDS ====================

  /**
   * Delete IPv4 Address Record (A Record)
   * Endpoint: /api/dns/manage/delete-ipv4-record.json
   */
  static async deleteIPv4Record(
    domainName: string,
    recordId: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/delete-ipv4-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub delete IPv4 record error:", error);
      return {
        status: "error",
        message: "Failed to delete IPv4 record",
      };
    }
  }

  /**
   * Delete IPv6 Address Record (AAAA Record)
   * Endpoint: /api/dns/manage/delete-ipv6-record.json
   */
  static async deleteIPv6Record(
    domainName: string,
    recordId: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/delete-ipv6-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub delete IPv6 record error:", error);
      return {
        status: "error",
        message: "Failed to delete IPv6 record",
      };
    }
  }

  /**
   * Delete CNAME Record
   * Endpoint: /api/dns/manage/delete-cname-record.json
   */
  static async deleteCNAMERecord(
    domainName: string,
    recordId: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/delete-cname-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub delete CNAME record error:", error);
      return {
        status: "error",
        message: "Failed to delete CNAME record",
      };
    }
  }

  /**
   * Delete MX Record
   * Endpoint: /api/dns/manage/delete-mx-record.json
   */
  static async deleteMXRecord(
    domainName: string,
    recordId: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/delete-mx-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub delete MX record error:", error);
      return {
        status: "error",
        message: "Failed to delete MX record",
      };
    }
  }

  /**
   * Delete NS Record
   * Endpoint: /api/dns/manage/delete-ns-record.json
   */
  static async deleteNSRecord(
    domainName: string,
    recordId: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/delete-ns-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub delete NS record error:", error);
      return {
        status: "error",
        message: "Failed to delete NS record",
      };
    }
  }

  /**
   * Delete TXT Record
   * Endpoint: /api/dns/manage/delete-txt-record.json
   */
  static async deleteTXTRecord(
    domainName: string,
    recordId: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/delete-txt-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub delete TXT record error:", error);
      return {
        status: "error",
        message: "Failed to delete TXT record",
      };
    }
  }

  /**
   * Delete SRV Record
   * Endpoint: /api/dns/manage/delete-srv-record.json
   */
  static async deleteSRVRecord(
    domainName: string,
    recordId: string
  ): Promise<ResellerClubResponse> {
    try {
      const response = await api.post("/api/dns/manage/delete-srv-record.json", null, {
        params: {
          "domain-name": domainName,
          "record-id": recordId,
        },
      });

      return {
        status: "success",
        data: response.data,
      };
    } catch (error) {
      serverLogger.error("ResellerClub delete SRV record error:", error);
      return {
        status: "error",
        message: "Failed to delete SRV record",
      };
    }
  }
}
