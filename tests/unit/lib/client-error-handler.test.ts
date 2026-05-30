/**
 * Tests for `@/lib/client-error-handler` (rescan-4 slice 7do).
 * Two pure helpers — parseApiResponse + getUserFriendlyErrorMessage.
 * Pins the JSON-vs-non-JSON branches, the application-level error
 * (data.success===false even when response.ok), and the friendly-
 * message mapping for the operational error codes.
 */
import { describe, it, expect } from "vitest";
import {
  parseApiResponse,
  getUserFriendlyErrorMessage,
  type ApiError,
} from "@/lib/client-error-handler";

function jsonResp(status: number, body: unknown, ok = status >= 200 && status < 300) {
  return {
    headers: new Headers({ "content-type": "application/json" }),
    status,
    ok,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function htmlResp(status: number, body: string) {
  return {
    headers: new Headers({ "content-type": "text/html" }),
    status,
    ok: false,
    json: async () => {
      throw new Error("invalid json");
    },
    text: async () => body,
  } as unknown as Response;
}

describe("parseApiResponse", () => {
  it("JSON 200 with no success field → returns parsed body", async () => {
    const out = await parseApiResponse<{ id: number }>(jsonResp(200, { id: 1 }));
    expect(out).toEqual({ id: 1 });
  });

  it("JSON 200 with success:false → throws ApiError with the error message", async () => {
    await expect(
      parseApiResponse(jsonResp(200, { success: false, error: "domain taken", code: "TAKEN" }))
    ).rejects.toMatchObject({
      message: "domain taken",
      code: "TAKEN",
      status: 200,
    });
  });

  it("JSON 200 with success:false but no error field → falls back to data.message → 'Request failed'", async () => {
    await expect(
      parseApiResponse(jsonResp(200, { success: false, message: "manual override" }))
    ).rejects.toMatchObject({ message: "manual override" });
    await expect(
      parseApiResponse(jsonResp(200, { success: false }))
    ).rejects.toMatchObject({ message: "Request failed", code: "UNKNOWN_ERROR" });
  });

  it("JSON 400 → throws ApiError with the supplied error + status=400", async () => {
    await expect(
      parseApiResponse(jsonResp(400, { error: "bad request" }))
    ).rejects.toMatchObject({ message: "bad request", status: 400 });
  });

  it("Non-JSON 503 → throws 'Service Unavailable' + code SERVICE_UNAVAILABLE + details", async () => {
    await expect(parseApiResponse(htmlResp(503, "<html>503</html>"))).rejects.toMatchObject({
      message: "Service Unavailable",
      code: "SERVICE_UNAVAILABLE",
      status: 503,
      details: "<html>503</html>",
    });
  });

  it("Non-JSON 500 → throws generic 'Server Error (500)' + code SERVER_ERROR", async () => {
    await expect(parseApiResponse(htmlResp(500, "<html>oops</html>"))).rejects.toMatchObject({
      message: "Server Error (500)",
      code: "SERVER_ERROR",
      status: 500,
    });
  });

  it("Non-JSON with unreadable body → details='Could not read response body'", async () => {
    const resp = {
      headers: new Headers({ "content-type": "text/plain" }),
      status: 500,
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
      text: async () => {
        throw new Error("network reset");
      },
    } as unknown as Response;
    await expect(parseApiResponse(resp)).rejects.toMatchObject({
      details: "Could not read response body",
    });
  });
});

describe("getUserFriendlyErrorMessage", () => {
  it("falsy input → generic copy", () => {
    expect(getUserFriendlyErrorMessage(undefined)).toBe("An unexpected error occurred.");
    expect(getUserFriendlyErrorMessage(null)).toBe("An unexpected error occurred.");
  });

  it("DA-server-down operational codes → 'Hosting Server is currently unreachable'", () => {
    const expected = "Hosting Server is currently unreachable. Please try again later.";
    expect(getUserFriendlyErrorMessage({ code: "DA_SERVER_DOWN" } as ApiError)).toBe(expected);
    expect(getUserFriendlyErrorMessage({ status: 503 } as ApiError)).toBe(expected);
    expect(getUserFriendlyErrorMessage({ status: 504 } as ApiError)).toBe(expected);
    expect(getUserFriendlyErrorMessage({ code: "SERVICE_UNAVAILABLE" } as ApiError)).toBe(expected);
  });

  it("NO_HOSTING → empty string (UI empty-state handles it)", () => {
    expect(getUserFriendlyErrorMessage({ code: "NO_HOSTING" } as ApiError)).toBe("");
  });

  it("'Failed to fetch' (network error) → connection-failed copy", () => {
    expect(getUserFriendlyErrorMessage({ message: "Failed to fetch" })).toBe(
      "Connection failed. Please check your internet connection."
    );
  });

  it("TypeError name (also network-flavoured) → connection-failed copy", () => {
    expect(getUserFriendlyErrorMessage({ name: "TypeError" })).toBe(
      "Connection failed. Please check your internet connection."
    );
  });

  it("falls back to err.message when present, else the generic copy", () => {
    expect(getUserFriendlyErrorMessage({ message: "specific reason" })).toBe(
      "specific reason"
    );
    expect(getUserFriendlyErrorMessage({})).toBe("An unexpected error occurred.");
  });
});
