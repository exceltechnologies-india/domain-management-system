/**
 * Unit tests for the ResellerClub anti-corruption layer (rescan-4 M1).
 * Pins the response-classification heuristics so a future RC wording
 * tweak can't silently flip outcomes between branches.
 */
import { describe, expect, it } from "vitest";
import { classifyRegisterDomainResponse } from "@/lib/integrations/resellerclub/classify";
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
});
