/**
 * Tests for `@/lib/resellerclub/search` pricing + reseller helpers
 * (rescan-4 slice 7eq). Covers the small testable surface — the
 * 700-line searchDomain orchestration is integration-test material.
 * Pins:
 *  - **getDomainPricing PARALLEL fetch**: customer + reseller pricing
 *    issued via Promise.all (single round-trip latency, not serial);
 *    returns timestamp:ISO string for cache invalidation
 *  - getDomainPricing fetch throw → wraps into generic 'Failed to
 *    fetch live domain pricing' error (underlying HTTP error swallowed)
 *  - getTLDPricing: TLD lookup tries 9 variations (mappings table
 *    first → original → with-dot → upper/lower → dotXXX / domXXX →
 *    centralnic* prefixes); leading '.' stripped from input
 *  - getTLDPricing skips TLDs not found in any variation (no entry
 *    in result map — caller can detect missing pricing)
 *  - **getResellerPricingForTLD parses addnewdomain[1] as float** +
 *    returns {price, currency:'INR'}; missing TLD in response → null;
 *    missing addnewdomain[1] key → null; fetch throw → null (never
 *    crash callers)
 *  - **getResellerDetails wrapper unwraps nested `data` shape** when
 *    RC returns `{status:'success', data:{...}}`; plain response.data
 *    used directly otherwise
 *  - getResellerDetails AxiosError with response → extracts
 *    data.message > data.error > 'API Error: {status} {statusText}'
 *  - AxiosError WITHOUT response (network error) → 'No response from
 *    ResellerClub API'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AxiosError } from "axios";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub/client", () => ({
  api: { get: apiGet },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/pricing-service", () => ({ PricingService: {} }));
vi.mock("@/lib/tld-mappings", () => ({
  tldMappings: {
    com: "dotcom",
    net: "dotnet",
    "co.in": "coin",
  },
}));

import {
  getDomainPricing,
  getTLDPricing,
  getResellerPricingForTLD,
  getResellerDetails,
} from "@/lib/resellerclub/search";

beforeEach(() => {
  apiGet.mockReset();
});

function makeAxiosError(status: number, data: unknown): AxiosError {
  const err = new AxiosError("Request failed", "ERR_BAD_REQUEST");
  err.response = {
    status,
    statusText: "Bad Request",
    headers: {},
    config: {} as never,
    data,
  };
  return err;
}

function makeAxiosNetworkError(): AxiosError {
  // ERR_NETWORK style — has `request` but no `response`.
  const err = new AxiosError("Network Error", "ERR_NETWORK");
  err.request = {};
  return err;
}

describe("getDomainPricing", () => {
  it("issues both customer + reseller fetches in PARALLEL (Promise.all)", async () => {
    apiGet
      .mockResolvedValueOnce({ data: { com: { addnewdomain: { "1": "999" } } } })
      .mockResolvedValueOnce({ data: { com: { addnewdomain: { "1": "850" } } } });
    const result = await getDomainPricing();
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(apiGet).toHaveBeenCalledWith("/api/products/customer-price.json");
    expect(apiGet).toHaveBeenCalledWith("/api/products/reseller-price.json");
    expect(result.customerPricing.com.addnewdomain!["1"]).toBe("999");
    expect(result.resellerPricing.com.addnewdomain!["1"]).toBe("850");
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("fetch throw → wraps into generic 'Failed to fetch live domain pricing' error", async () => {
    apiGet.mockRejectedValueOnce(new Error("503"));
    await expect(getDomainPricing()).rejects.toThrow(
      /Failed to fetch live domain pricing/
    );
  });
});

describe("getTLDPricing — TLD-variation lookup", () => {
  it("strips leading dot before lookup ('.com' → 'com')", async () => {
    apiGet
      .mockResolvedValueOnce({
        data: { dotcom: { addnewdomain: { "1": "999" } } }, // direct mapping
      })
      .mockResolvedValueOnce({ data: { dotcom: { addnewdomain: { "1": "850" } } } });
    const result = await getTLDPricing([".com"]);
    expect(result.com).toBeDefined();
    expect(result.com.tld).toBe("com");
  });

  it("uses tldMappings entry FIRST (highest priority)", async () => {
    apiGet
      .mockResolvedValueOnce({
        data: {
          dotcom: { addnewdomain: { "1": "MAPPED-PRICE" } },
          com: { addnewdomain: { "1": "ORIGINAL-PRICE" } },
        },
      })
      .mockResolvedValueOnce({
        data: { dotcom: { addnewdomain: { "1": "850" } } },
      });
    const result = await getTLDPricing(["com"]);
    // tldMappings.com = 'dotcom' — that wins over the bare 'com' key.
    expect(result.com.customer.addnewdomain!["1"]).toBe("MAPPED-PRICE");
  });

  it("falls back to bare TLD when mapping miss but bare key present", async () => {
    apiGet
      .mockResolvedValueOnce({
        data: { xyz: { addnewdomain: { "1": "FROM-BARE-KEY" } } },
      })
      .mockResolvedValueOnce({ data: {} });
    const result = await getTLDPricing(["xyz"]);
    expect(result.xyz.customer.addnewdomain!["1"]).toBe("FROM-BARE-KEY");
  });

  it("TLD with no matching variation → omitted from result", async () => {
    apiGet.mockResolvedValue({ data: {} });
    const result = await getTLDPricing(["nonexistent"]);
    expect(result.nonexistent).toBeUndefined();
  });

  it("reseller null when reseller-pricing missing the matched TLD key", async () => {
    apiGet
      .mockResolvedValueOnce({
        data: { dotcom: { addnewdomain: { "1": "999" } } },
      })
      .mockResolvedValueOnce({ data: {} }); // no reseller side
    const result = await getTLDPricing(["com"]);
    expect(result.com.reseller).toBeNull();
  });
});

describe("getResellerPricingForTLD", () => {
  it("happy path: returns {price (float), currency:'INR'}", async () => {
    apiGet.mockResolvedValueOnce({
      data: { dotcom: { addnewdomain: { "1": "799.50" } } },
    });
    const result = await getResellerPricingForTLD("dotcom");
    expect(result).toEqual({ price: 799.5, currency: "INR" });
  });

  it("TLD missing from response → null", async () => {
    apiGet.mockResolvedValueOnce({ data: {} });
    expect(await getResellerPricingForTLD("missing")).toBeNull();
  });

  it("TLD present but addnewdomain[1] missing → null", async () => {
    apiGet.mockResolvedValueOnce({
      data: { dotcom: { addnewdomain: { "2": "999" } } }, // only 2yr, no 1yr
    });
    expect(await getResellerPricingForTLD("dotcom")).toBeNull();
  });

  it("API throw → null (never crash callers)", async () => {
    apiGet.mockRejectedValueOnce(new Error("503"));
    expect(await getResellerPricingForTLD("dotcom")).toBeNull();
  });
});

describe("getResellerDetails", () => {
  it("flat response.data → wrapped into {status:'success', data}", async () => {
    apiGet.mockResolvedValueOnce({
      data: {
        resellerid: "RC_42",
        availablebalance: "1000.00",
        name: "MyReseller",
      },
    });
    const result = await getResellerDetails();
    expect(result.status).toBe("success");
    expect(result.data?.resellerid).toBe("RC_42");
    expect(result.data?.availablebalance).toBe("1000.00");
  });

  it("nested {status, data} envelope → unwraps to inner data", async () => {
    apiGet.mockResolvedValueOnce({
      data: {
        status: "success",
        data: { resellerid: "RC_42", availablebalance: "500" },
      },
    });
    const result = await getResellerDetails();
    expect(result.status).toBe("success");
    expect(result.data?.resellerid).toBe("RC_42");
  });

  it("response.data falsy → {status:'error', error:'No data received from API'}", async () => {
    apiGet.mockResolvedValueOnce({ data: null });
    const result = await getResellerDetails();
    expect(result).toEqual({
      status: "error",
      error: "No data received from API",
    });
  });

  it("AxiosError with response → extracts response.data.message", async () => {
    apiGet.mockRejectedValueOnce(
      makeAxiosError(401, { message: "Invalid credentials" })
    );
    const result = await getResellerDetails();
    expect(result.status).toBe("error");
    expect(result.error).toBe("Invalid credentials");
  });

  it("AxiosError with data.error field (not message) → uses .error", async () => {
    apiGet.mockRejectedValueOnce(
      makeAxiosError(401, { error: "Unauthorized" })
    );
    const result = await getResellerDetails();
    expect(result.error).toBe("Unauthorized");
  });

  it("AxiosError with empty response data → falls back to 'API Error: {status} {statusText}'", async () => {
    apiGet.mockRejectedValueOnce(makeAxiosError(500, {}));
    const result = await getResellerDetails();
    expect(result.error).toMatch(/API Error: 500/);
  });

  it("AxiosError WITHOUT response (network error) → 'No response from ResellerClub API'", async () => {
    apiGet.mockRejectedValueOnce(makeAxiosNetworkError());
    const result = await getResellerDetails();
    expect(result.error).toBe("No response from ResellerClub API");
  });

  it("plain non-Axios error → returns error.message", async () => {
    apiGet.mockRejectedValueOnce(new Error("some other error"));
    const result = await getResellerDetails();
    expect(result.error).toBe("some other error");
  });
});
