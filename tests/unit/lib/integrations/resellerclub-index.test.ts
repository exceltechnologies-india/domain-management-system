/**
 * Tests for `@/lib/integrations/resellerclub` barrel (rescan-4 slice 7de).
 * Pins the export contract for the ResellerClub anti-corruption layer
 * (see ./types.ts for the M1 design). A future rename of any underlying
 * module surfaces here.
 *
 * `@/lib/resellerclub/client` throws at module-load time when the RC
 * env vars are missing — set them via vi.hoisted so they're in place
 * before the static import is resolved.
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.RESELLERCLUB_API_URL = "https://test-api.resellerclub.example.com";
  process.env.RESELLERCLUB_ID = "test-id";
  process.env.RESELLERCLUB_SECRET = "test-secret";
});

import * as barrel from "@/lib/integrations/resellerclub";

describe("ResellerClub barrel", () => {
  it("re-exports the 6 operation functions", () => {
    expect(typeof barrel.registerDomain).toBe("function");
    expect(typeof barrel.renewDomain).toBe("function");
    expect(typeof barrel.transferDomain).toBe("function");
    expect(typeof barrel.getDomainOrderId).toBe("function");
    expect(typeof barrel.getDomainDetails).toBe("function");
    expect(typeof barrel.getDNSRecords).toBe("function");
  });

  it("re-exports the 6 classify* functions", () => {
    expect(typeof barrel.classifyRegisterDomainResponse).toBe("function");
    expect(typeof barrel.classifyRenewDomainResponse).toBe("function");
    expect(typeof barrel.classifyTransferDomainResponse).toBe("function");
    expect(typeof barrel.classifyGetDomainOrderIdResponse).toBe("function");
    expect(typeof barrel.classifyGetDomainDetailsResponse).toBe("function");
    expect(typeof barrel.classifyGetDNSRecordsResponse).toBe("function");
  });

  it("re-exports the matchesAny helper + the fragment-keyword lists", () => {
    expect(typeof barrel.matchesAny).toBe("function");
    expect(Array.isArray(barrel.BALANCE_PENDING_FRAGMENTS)).toBe(true);
    expect(Array.isArray(barrel.PROCESSING_LOCK_FRAGMENTS)).toBe(true);
    expect(Array.isArray(barrel.ALREADY_IN_PROGRESS_FRAGMENTS)).toBe(true);
    expect(Array.isArray(barrel.TRANSFER_REJECTED_FRAGMENTS)).toBe(true);
    expect(Array.isArray(barrel.READ_NOT_FOUND_FRAGMENTS)).toBe(true);
  });

  it("matchesAny is a curried lower-case substring matcher", () => {
    expect(barrel.matchesAny("Some Balance Pending here", ["balance pending"])).toBe(true);
    expect(barrel.matchesAny("nothing relevant", ["balance pending"])).toBe(false);
  });
});
