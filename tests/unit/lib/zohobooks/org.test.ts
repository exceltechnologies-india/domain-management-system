/**
 * Tests for `@/lib/zohobooks/org` (rescan-4 slice 7dz).
 * getOrganizationDetails — the Zoho-Books-init gate. Pins:
 *  - early-return null when refresh token not configured (lazy init —
 *    callers shouldn't crash on missing-config; they get null)
 *  - matches `organization_id === self._orgId` with **String() coercion
 *    on both sides** (Zoho returns numeric IDs as strings sometimes)
 *  - falls back to orgs[0] when no _orgId match (single-org tenants)
 *  - response.data.code !== 0 → null (Zoho's success sentinel)
 *  - response.data.organizations missing → null
 *  - axios throw → unwrapZohoError + logger.error + null (caller-safe)
 *  - delegates the HTTP call through self._idempotentRetry (so 503s retry)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const zohoAxiosGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks/axios-client", () => ({
  zohoAxios: { get: zohoAxiosGet },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { getOrganizationDetails } from "@/lib/zohobooks/org";

function makeSelf(overrides: Partial<{
  hasToken: boolean;
  orgId: string;
  retryThrows: boolean;
}> = {}) {
  return {
    _hasRefreshToken: vi.fn().mockReturnValue(overrides.hasToken ?? true),
    _getHeaders: vi.fn().mockResolvedValue({ Authorization: "Zoho-oauthtoken X" }),
    _idempotentRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    _baseUrl: "https://www.zohoapis.com/books/v3",
    _orgId: overrides.orgId ?? "ORG_123",
  };
}

beforeEach(() => {
  zohoAxiosGet.mockReset();
});

describe("getOrganizationDetails", () => {
  it("returns null + skips HTTP when refresh token isn't configured", async () => {
    const self = makeSelf({ hasToken: false });
    const result = await getOrganizationDetails(self as never);
    expect(result).toBeNull();
    expect(zohoAxiosGet).not.toHaveBeenCalled();
  });

  it("matches organization_id via String() coercion (works for numeric IDs)", async () => {
    const self = makeSelf({ orgId: "ORG_123" });
    zohoAxiosGet.mockResolvedValueOnce({
      data: {
        code: 0,
        organizations: [
          { organization_id: "ORG_999", name: "wrong" },
          { organization_id: "ORG_123", name: "match" },
        ],
      },
    });
    const result = await getOrganizationDetails(self as never);
    expect(result?.name).toBe("match");
  });

  it("numeric organization_id vs string _orgId: String()-coerced match still works", async () => {
    const self = makeSelf({ orgId: "777" });
    zohoAxiosGet.mockResolvedValueOnce({
      data: {
        code: 0,
        organizations: [{ organization_id: 777, name: "numeric-id" }],
      },
    });
    const result = await getOrganizationDetails(self as never);
    expect(result?.name).toBe("numeric-id");
  });

  it("falls back to orgs[0] when no organization_id matches", async () => {
    const self = makeSelf({ orgId: "nonexistent" });
    zohoAxiosGet.mockResolvedValueOnce({
      data: {
        code: 0,
        organizations: [
          { organization_id: "first", name: "first-tenant" },
          { organization_id: "second", name: "second-tenant" },
        ],
      },
    });
    const result = await getOrganizationDetails(self as never);
    expect(result?.name).toBe("first-tenant");
  });

  it("Zoho returns code != 0 → returns null", async () => {
    const self = makeSelf();
    zohoAxiosGet.mockResolvedValueOnce({
      data: { code: 14001, message: "invalid token" },
    });
    const result = await getOrganizationDetails(self as never);
    expect(result).toBeNull();
  });

  it("Zoho returns code:0 but no organizations array → returns null", async () => {
    const self = makeSelf();
    zohoAxiosGet.mockResolvedValueOnce({ data: { code: 0 } });
    const result = await getOrganizationDetails(self as never);
    expect(result).toBeNull();
  });

  it("axios throw → returns null (logged via unwrapZohoError, never bubbles)", async () => {
    const self = makeSelf();
    zohoAxiosGet.mockRejectedValueOnce(new Error("503"));
    const result = await getOrganizationDetails(self as never);
    expect(result).toBeNull();
  });

  it("delegates HTTP through self._idempotentRetry (so transient 503s get retried)", async () => {
    const self = makeSelf();
    zohoAxiosGet.mockResolvedValueOnce({
      data: { code: 0, organizations: [{ organization_id: "ORG_123", name: "x" }] },
    });
    await getOrganizationDetails(self as never);
    expect(self._idempotentRetry).toHaveBeenCalledTimes(1);
  });
});
