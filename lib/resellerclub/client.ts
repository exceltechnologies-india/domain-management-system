/**
 * ResellerClub API client
 *
 * Shared axios instance + interceptors + env-var validation for all
 * resellerclub submodules.
 */

import axios, { AxiosError, AxiosResponse } from "axios";
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

// Configure Axios instance with ResellerClub API settings
export const api = axios.create({
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
