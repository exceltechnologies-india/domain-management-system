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
