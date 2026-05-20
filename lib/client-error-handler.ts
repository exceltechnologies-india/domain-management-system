
/**
 * Standardized API Error Interface
 */
export interface ApiError {
  message: string;
  code?: string;
  status?: number;
  details?: unknown;
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
export function getUserFriendlyErrorMessage(error: unknown): string {
  if (!error) return "An unexpected error occurred.";

  const err = error as { code?: string; status?: number; message?: string; name?: string };

  // Specific DirectAdmin Server Down scenarios
  if (err.code === 'DA_SERVER_DOWN' || err.status === 503 || err.status === 504 || err.code === 'SERVICE_UNAVAILABLE') {
      return "Hosting Server is currently unreachable. Please try again later.";
  }

  if (err.code === 'NO_HOSTING') {
      return ""; // Usually handled by UI empty state, but safe fallback
  }

  // Network errors often don't have a response object
  if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
      return "Connection failed. Please check your internet connection.";
  }

  return err.message || "An unexpected error occurred.";
}
