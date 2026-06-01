/**
 * Tests for `@/lib/resellerclub` barrel (rescan-4 slice 7dw).
 * Backwards-compat class shim that re-exports ~25 static methods from
 * the per-topic submodules (search / customers / registration / dns /
 * renewal-transfer). Pins the full surface so a future submodule
 * rename / removal surfaces here.
 *
 * The client module throws at module-load when env vars are missing —
 * stub via vi.hoisted before the static import.
 */
import { describe, it, expect } from "vitest";
import { vi } from "vitest";

vi.hoisted(() => {
  process.env.RESELLERCLUB_API_URL = "https://test-api.resellerclub.example.com";
  process.env.RESELLERCLUB_ID = "test-id";
  process.env.RESELLERCLUB_SECRET = "test-secret";
});

import { ResellerClubAPI } from "@/lib/resellerclub";

describe("ResellerClubAPI class shim", () => {
  it.each([
    // search (6)
    "getDomainPricing",
    "getTLDPricing",
    "searchDomain",
    "searchDomainWithTlds",
    "getResellerPricingForTLD",
    "getResellerDetails",
    // customers (8)
    "getCustomerId",
    "createCustomer",
    "modifyCustomer",
    "modifyContact",
    "createContact",
    "getOrCreateCustomerAndContact",
    "getCustomerDetails",
    "getCustomerDomains",
    // registration (5)
    "deleteDomainOrder",
    "registerDomain",
    "getDomainDetails",
    "getDomainExpiry",
    "getDomainOrderId",
    // dns (8)
    "activateDNSManagement",
    "getDNSRecords",
    "addDNSRecord",
    "updateDNSRecord",
    "deleteDNSRecord",
    "setDefaultNameservers",
    "setCustomNameservers",
    "getNameservers",
    // renewal-transfer (3)
    "getRenewalPricing",
    "renewDomain",
    "transferDomain",
  ])("exposes %s as a static method", (name) => {
    expect(typeof (ResellerClubAPI as unknown as Record<string, unknown>)[name]).toBe(
      "function"
    );
  });

  it("re-exports each submodule's same function reference (no per-call wrapper)", async () => {
    const search = await import("@/lib/resellerclub/search");
    expect(ResellerClubAPI.searchDomain).toBe(search.searchDomain);
    expect(ResellerClubAPI.getDomainPricing).toBe(search.getDomainPricing);
  });
});
