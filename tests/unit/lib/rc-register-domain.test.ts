/**
 * Unit tests for the ResellerClub anti-corruption layer (rescan-4 M1).
 * Pins the response-classification heuristics so a future RC wording
 * tweak can't silently flip outcomes between branches.
 */
import { describe, expect, it } from "vitest";
import {
  classifyRegisterDomainResponse,
  classifyRenewDomainResponse,
  classifyTransferDomainResponse,
  classifyGetDomainOrderIdResponse,
  classifyGetDomainDetailsResponse,
  classifyGetDNSRecordsResponse,
} from "@/lib/integrations/resellerclub/classify";
import type { ResellerClubResponse } from "@/lib/types";

const baseResponse = (overrides: Partial<ResellerClubResponse>): ResellerClubResponse =>
  ({
    status: "error",
    ...overrides,
  } as ResellerClubResponse);

describe("classifyRegisterDomainResponse", () => {
  it("status:success with orderid → registered", () => {
    const out = classifyRegisterDomainResponse(
      baseResponse({ status: "success", data: { orderid: "RC-12345" } })
    );
    expect(out.kind).toBe("registered");
    if (out.kind === "registered") expect(out.orderId).toBe("RC-12345");
  });

  it("status:success without orderid → registered_no_order_id", () => {
    const out = classifyRegisterDomainResponse(
      baseResponse({ status: "success", data: {} })
    );
    expect(out.kind).toBe("registered_no_order_id");
  });

  it("status:pending → balance_pending", () => {
    const out = classifyRegisterDomainResponse(baseResponse({ status: "pending" }));
    expect(out.kind).toBe("balance_pending");
  });

  it.each([
    "Insufficient balance to register the domain",
    "Account has low funds, cannot proceed",
    "Insufficient FUNDS — top up required",
    "Reseller account balance is below threshold",
    "Credit limit exceeded",
  ])("status:error with %s message → balance_pending", (msg) => {
    const out = classifyRegisterDomainResponse(
      baseResponse({ status: "error", message: msg })
    );
    expect(out.kind).toBe("balance_pending");
  });

  it.each([
    "Domain already exists in our database",
    "There is a pending order for this domain",
    "Pending order for the requested domain — try again",
  ])("status:error with %s message → already_in_progress", (msg) => {
    const out = classifyRegisterDomainResponse(
      baseResponse({ status: "error", message: msg })
    );
    expect(out.kind).toBe("already_in_progress");
  });

  it("status:error with an unrelated message → hard_failure with the reason", () => {
    const out = classifyRegisterDomainResponse(
      baseResponse({ status: "error", message: "TLD validation failed: invalid contact" })
    );
    expect(out.kind).toBe("hard_failure");
    if (out.kind === "hard_failure") {
      expect(out.reason).toBe("TLD validation failed: invalid contact");
    }
  });

  it("status:error with no message → hard_failure with synthesised reason", () => {
    const out = classifyRegisterDomainResponse(
      baseResponse({ status: "error" })
    );
    expect(out.kind).toBe("hard_failure");
    if (out.kind === "hard_failure") {
      expect(out.reason).toMatch(/RC returned status=error/);
    }
  });

  // Batch 7j added "please contact support" + the processing-lock
  // fragments so the inner registration.ts layer and this outer
  // classifier can't drift.
  it.each([
    "Please contact support for further assistance",
    "Order locked for processing — try again later",
    "locked for processing",
    "Domain Registration: processing",
  ])("treats new fragment as balance_pending: %s", (msg) => {
    const out = classifyRegisterDomainResponse(
      baseResponse({ status: "error", message: msg })
    );
    expect(out.kind).toBe("balance_pending");
  });
});

describe("classifyRenewDomainResponse", () => {
  it("status:success with orderid + price → renewed (number price)", () => {
    const out = classifyRenewDomainResponse(
      baseResponse({ status: "success", data: { orderid: "RC-RNW-1", price: 1499 } })
    );
    expect(out.kind).toBe("renewed");
    if (out.kind === "renewed") {
      expect(out.orderId).toBe("RC-RNW-1");
      expect(out.price).toBe(1499);
    }
  });

  it("coerces numeric-string price field to number", () => {
    const out = classifyRenewDomainResponse(
      baseResponse({ status: "success", data: { orderid: "X", price: "899.50" } })
    );
    expect(out.kind).toBe("renewed");
    if (out.kind === "renewed") expect(out.price).toBeCloseTo(899.5);
  });

  it("status:success without price → renewed with undefined price", () => {
    const out = classifyRenewDomainResponse(
      baseResponse({ status: "success", data: { orderid: "X" } })
    );
    expect(out.kind).toBe("renewed");
    if (out.kind === "renewed") expect(out.price).toBeUndefined();
  });

  it.each([
    "Insufficient balance",
    "Reseller account balance below threshold",
    "Insufficient funds in account",
    "Reseller credit limit reached",
  ])("balance-pending fragments are recognised: %s", (msg) => {
    const out = classifyRenewDomainResponse(
      baseResponse({ status: "error", message: msg })
    );
    expect(out.kind).toBe("balance_pending");
  });

  it("status:pending → balance_pending", () => {
    expect(classifyRenewDomainResponse(baseResponse({ status: "pending" })).kind).toBe(
      "balance_pending"
    );
  });

  it("registry rejection → hard_failure", () => {
    const out = classifyRenewDomainResponse(
      baseResponse({ status: "error", message: "Domain is locked at registry" })
    );
    expect(out.kind).toBe("hard_failure");
  });
});

describe("classifyTransferDomainResponse", () => {
  it("status:success with entityid → transfer_initiated", () => {
    const out = classifyTransferDomainResponse(
      baseResponse({ status: "success", data: { entityid: 12345 } })
    );
    expect(out.kind).toBe("transfer_initiated");
    if (out.kind === "transfer_initiated") expect(out.entityId).toBe("12345");
  });

  it("status:success without entityid → transfer_initiated (entityId undefined)", () => {
    const out = classifyTransferDomainResponse(
      baseResponse({ status: "success", data: {} })
    );
    expect(out.kind).toBe("transfer_initiated");
    if (out.kind === "transfer_initiated") expect(out.entityId).toBeUndefined();
  });

  it.each([
    "Invalid auth code provided",
    "auth-code mismatch",
    "Bad authcode",
    "Invalid EPP key for this domain",
    "Transfer is prohibited at the registry",
    "clientTransferProhibited",
    "Domain is within 60 days of registration",
    "60-day rule still applies",
    "Transfer not allowed for transfer right now",
  ])("registry-rejection fragment is recognised: %s", (msg) => {
    const out = classifyTransferDomainResponse(
      baseResponse({ status: "error", message: msg })
    );
    expect(out.kind).toBe("transfer_rejected");
  });

  it.each([
    "Insufficient balance",
    "Account balance is below threshold",
  ])("balance fragment → balance_pending: %s", (msg) => {
    const out = classifyTransferDomainResponse(
      baseResponse({ status: "error", message: msg })
    );
    expect(out.kind).toBe("balance_pending");
  });

  it("status:pending → balance_pending", () => {
    expect(classifyTransferDomainResponse(baseResponse({ status: "pending" })).kind).toBe(
      "balance_pending"
    );
  });

  it("unrelated error → hard_failure", () => {
    const out = classifyTransferDomainResponse(
      baseResponse({ status: "error", message: "Network connection refused" })
    );
    expect(out.kind).toBe("hard_failure");
  });
});

describe("classifyGetDomainOrderIdResponse", () => {
  it("status:success with data string → found", () => {
    const out = classifyGetDomainOrderIdResponse(
      baseResponse({ status: "success", data: "RC-98765" })
    );
    expect(out.kind).toBe("found");
    if (out.kind === "found") expect(out.orderId).toBe("RC-98765");
  });

  it("status:success with numeric data → found (stringified)", () => {
    const out = classifyGetDomainOrderIdResponse(
      baseResponse({ status: "success", data: 12345 as unknown as undefined })
    );
    expect(out.kind).toBe("found");
    if (out.kind === "found") expect(out.orderId).toBe("12345");
  });

  it("status:success but data is the literal string 'undefined' → not_found", () => {
    // Defensive: occasional RC quirk where the order id is missing
    // but the wrapper still returns status=success.
    const out = classifyGetDomainOrderIdResponse(
      baseResponse({ status: "success", data: "undefined" as unknown as undefined })
    );
    expect(out.kind).toBe("not_found");
  });

  it.each([
    "404 Not Found",
    "Domain not found in your account",
    "No orders found for this domain",
    "No order found",
    "no matching entity",
    "no domain registered with this name",
    "Domain does not exist",
    "Could not find the requested resource",
  ])("not-found fragment recognised: %s", (msg) => {
    const out = classifyGetDomainOrderIdResponse(
      baseResponse({ status: "error", message: msg })
    );
    expect(out.kind).toBe("not_found");
  });

  it("unrelated error → hard_failure", () => {
    const out = classifyGetDomainOrderIdResponse(
      baseResponse({ status: "error", message: "Connection refused by upstream" })
    );
    expect(out.kind).toBe("hard_failure");
    if (out.kind === "hard_failure") {
      expect(out.reason).toBe("Connection refused by upstream");
    }
  });

  it("undefined message + error status → hard_failure with synthesised reason", () => {
    const out = classifyGetDomainOrderIdResponse(
      baseResponse({ status: "error" })
    );
    expect(out.kind).toBe("hard_failure");
    if (out.kind === "hard_failure") {
      expect(out.reason).toMatch(/status=error/);
    }
  });
});

describe("classifyGetDomainDetailsResponse", () => {
  it("status:success with data → found", () => {
    const out = classifyGetDomainDetailsResponse(
      baseResponse({
        status: "success",
        data: {
          endtime: "1800000000",
          creationtime: "1700000000",
          domainstatus: "Active",
        },
      })
    );
    expect(out.kind).toBe("found");
    if (out.kind === "found") expect(out.details.domainstatus).toBe("Active");
  });

  it.each([
    "404 from registrar",
    "no domain found",
    "domain does not exist on our account",
  ])("not-found fragment recognised: %s", (msg) => {
    const out = classifyGetDomainDetailsResponse(
      baseResponse({ status: "error", message: msg })
    );
    expect(out.kind).toBe("not_found");
  });

  it("error without not-found fragment → hard_failure", () => {
    const out = classifyGetDomainDetailsResponse(
      baseResponse({ status: "error", message: "Failed to fetch domain details" })
    );
    expect(out.kind).toBe("hard_failure");
  });

  it("status:success but no data → hard_failure", () => {
    // Inner wrapper guarantees success only when response.data is set;
    // belt-and-braces — if some upstream layer drops the data, treat it
    // as hard rather than crashing on undefined access at the callsite.
    const out = classifyGetDomainDetailsResponse(
      baseResponse({ status: "success", data: undefined })
    );
    expect(out.kind).toBe("hard_failure");
  });
});

describe("classifyGetDNSRecordsResponse", () => {
  it("status:success with records array → found", () => {
    const records = [
      { type: "A", value: "192.0.2.1", id: "1", ttl: 3600, name: "@" },
      { type: "MX", value: "mail.example.com", id: "2", ttl: 3600, priority: 10 },
    ];
    const out = classifyGetDNSRecordsResponse(
      baseResponse({ status: "success", data: { records, total: 2 } })
    );
    expect(out.kind).toBe("found");
    if (out.kind === "found") {
      expect(out.records).toHaveLength(2);
      expect(out.records[0].type).toBe("A");
    }
  });

  it("status:success with empty records → found (empty array, not not_found)", () => {
    const out = classifyGetDNSRecordsResponse(
      baseResponse({ status: "success", data: { records: [], total: 0 } })
    );
    expect(out.kind).toBe("found");
    if (out.kind === "found") expect(out.records).toEqual([]);
  });

  it("status:success with malformed data (no records key) → found with empty array", () => {
    // Belt-and-braces — keep the route handler crash-free even if the
    // inner wrapper shape drifts upstream.
    const out = classifyGetDNSRecordsResponse(
      baseResponse({ status: "success", data: { total: 0 } })
    );
    expect(out.kind).toBe("found");
    if (out.kind === "found") expect(out.records).toEqual([]);
  });

  it.each([
    "Request failed with status code 404",
    "Domain not found",
    "no domain registered",
    "does not exist",
  ])("not-found fragment recognised: %s", (msg) => {
    const out = classifyGetDNSRecordsResponse(
      baseResponse({ status: "error", message: msg })
    );
    expect(out.kind).toBe("not_found");
  });

  it("unrelated error → hard_failure", () => {
    const out = classifyGetDNSRecordsResponse(
      baseResponse({ status: "error", message: "Failed to get DNS records" })
    );
    expect(out.kind).toBe("hard_failure");
    if (out.kind === "hard_failure") {
      expect(out.reason).toBe("Failed to get DNS records");
    }
  });

  it("undefined message + error status → hard_failure with synthesised reason", () => {
    const out = classifyGetDNSRecordsResponse(
      baseResponse({ status: "error" })
    );
    expect(out.kind).toBe("hard_failure");
    if (out.kind === "hard_failure") {
      expect(out.reason).toMatch(/status=error/);
    }
  });
});
