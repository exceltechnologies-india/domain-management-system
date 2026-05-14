
/**
 * Standardized API Error Interface
 */
export interface ApiError {
  message: string;
  code?: string;
  status?: number;
  details?: any;
}

/**
 * Helper to parse API responses, handling both JSON and non-JSON (HTML 500s) errors.
 * Throws a standarized ApiError object if the request failed.
 */
export async function parseApiResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type");
  
  // 1. Handle JSON Responses
  if (contentType && contentType.includes("application/json")) {
      const data = await response.json();
      
      // Check for application-level error (success: false)
      if (!response.ok || (data && data.success === false)) {
          throw { 
              message: data.error || data.message || "Request failed", 
              code: data.code || 'UNKNOWN_ERROR', 
              status: response.status 
          } as ApiError;
      }
      
      return data;
  } 
  
  // 2. Handle Non-JSON Responses (e.g., HTML 503 from Proxy, 500 from Next.js crash)
  else {
      let text = "";
      try {
          text = await response.text();
      } catch (e) {
          text = "Could not read response body";
      }

      throw { 
          message: response.status === 503 ? "Service Unavailable" : `Server Error (${response.status})`,
          code: response.status === 503 ? "SERVICE_UNAVAILABLE" : "SERVER_ERROR",
          status: response.status,
          details: text 
      } as ApiError;
  }
}

/**
 * Maps technical error codes/statuses to user-friendly messages
 */
export function getUserFriendlyErrorMessage(error: any): string {
  if (!error) return "An unexpected error occurred.";

  const code = error.code as string;
  const status = error.status as number;

  // Specific DirectAdmin Server Down scenarios
  if (code === 'DA_SERVER_DOWN' || status === 503 || status === 504 || code === 'SERVICE_UNAVAILABLE') {
      return "Hosting Server is currently unreachable. Please try again later.";
  }
  
  if (code === 'NO_HOSTING') {
      return ""; // Usually handled by UI empty state, but safe fallback
  }

  // Network errors often don't have a response object
  if (error.message === 'Failed to fetch' || error.name === 'TypeError') {
      return "Connection failed. Please check your internet connection.";
  }

  return error.message || "An unexpected error occurred.";
}
