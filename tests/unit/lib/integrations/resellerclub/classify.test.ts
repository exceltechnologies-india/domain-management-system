/**
 * Tests for `@/lib/integrations/resellerclub/classify` (rescan-4 slice 7ef).
 * Pure RC-response → typed-outcome classifiers. Pins:
 *  - 4 shared vocabularies: BALANCE_PENDING (7 fragments incl. "please
 *    contact support" — RC sometimes wraps balance in support-contact
 *    wording), PROCESSING_LOCK (3), ALREADY_IN_PROGRESS (3), READ_NOT_FOUND
 *    (9), TRANSFER_REJECTED (11)
 *  - classifyRegisterDomainResponse: status:'success' → registered or
 *    registered_no_order_id (orderid missing/falsy); status:'pending' →
 *    balance_pending; balance/processing-fragment matches in error msgs
 *    → balance_pending; in-progress fragment → already_in_progress;
 *    fallthrough → hard_failure with stamped status if no message
 *  - classifyRenewDomainResponse: same shape but with `price` (number OR
 *    string-coerced; NaN-guarded via Number.isFinite)
 *  - classifyGetDomainOrderId: success+data → found(String(data));
 *    'undefined' / 'null' / '' literal strings → not_found
 *  - classifyGetDomainDetails: success → details cast through; READ_NOT_FOUND
 *    fragment → not_found
 *  - classifyGetDNSRecords: success → records (Array.isArray check, [] if
 *    not an array); empty records IS found, not_found is reserved for
 *    "domain not under DNS management here"
 *  - classifyTransferDomain: success → transfer_initiated with entityId;
 *    TRANSFER_REJECTED fragments → transfer_rejected
 */
import { describe, it, expect } from "vitest";
import {
  BALANCE_PENDING_FRAGMENTS,
  PROCESSING_LOCK_FRAGMENTS,
  ALREADY_IN_PROGRESS_FRAGMENTS,
  READ_NOT_FOUND_FRAGMENTS,
  TRANSFER_REJECTED_FRAGMENTS,
  matchesAny,
  classifyRegisterDomainResponse,
  classifyRenewDomainResponse,
  classifyGetDomainOrderIdResponse,
  classifyGetDomainDetailsResponse,
  classifyGetDNSRecordsResponse,
  classifyTransferDomainResponse,
} from "@/lib/integrations/resellerclub/classify";
import type { ResellerClubResponse } from "@/lib/types";

describe("vocabulary constants", () => {
  it("BALANCE_PENDING_FRAGMENTS includes 'please contact support' (RC wraps balance issues)", () => {
    expect(BALANCE_PENDING_FRAGMENTS).toContain("insufficient balance");
    expect(BALANCE_PENDING_FRAGMENTS).toContain("credit limit");
    expect(BALANCE_PENDING_FRAGMENTS).toContain("please contact support");
  });

  it("READ_NOT_FOUND_FRAGMENTS covers the 9 RC 'not found' wordings", () => {
    expect(READ_NOT_FOUND_FRAGMENTS).toEqual([
      "404",
      "not found",
      "no orders found",
      "no order found",
      "no matching",
      "no entity found",
      "no domain",
      "does not exist",
      "could not find",
    ]);
  });

  it("TRANSFER_REJECTED_FRAGMENTS covers EPP + transfer-lock + 60-day forms", () => {
    expect(TRANSFER_REJECTED_FRAGMENTS).toContain("auth code");
    expect(TRANSFER_REJECTED_FRAGMENTS).toContain("invalid epp");
    expect(TRANSFER_REJECTED_FRAGMENTS).toContain("clienttransferprohibited");
    expect(TRANSFER_REJECTED_FRAGMENTS).toContain("60 day");
    expect(TRANSFER_REJECTED_FRAGMENTS).toContain("60-day");
  });
});

describe("matchesAny", () => {
  it("case-insensitive substring match", () => {
    expect(matchesAny("Order LOCKED FOR Processing", PROCESSING_LOCK_FRAGMENTS)).toBe(true);
  });

  it("undefined / empty → false", () => {
    expect(matchesAny(undefined, BALANCE_PENDING_FRAGMENTS)).toBe(false);
    expect(matchesAny("", BALANCE_PENDING_FRAGMENTS)).toBe(false);
  });
});

describe("classifyRegisterDomainResponse", () => {
  it("status:'success' + orderid → registered with stringified orderId", () => {
    const r: ResellerClubResponse = { status: "success", data: { orderid: 12345 } };
    expect(classifyRegisterDomainResponse(r)).toEqual({
      kind: "registered",
      orderId: "12345",
    });
  });

  it("status:'success' but orderid missing → registered_no_order_id", () => {
    const r: ResellerClubResponse = { status: "success", data: {} };
    expect(classifyRegisterDomainResponse(r)).toEqual({
      kind: "registered_no_order_id",
    });
  });

  it("status:'pending' → balance_pending (RC's explicit pending sentinel)", () => {
    const r: ResellerClubResponse = { status: "pending" };
    expect(classifyRegisterDomainResponse(r)).toEqual({ kind: "balance_pending" });
  });

  it("error message with balance fragment → balance_pending", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Insufficient balance to complete order",
    };
    expect(classifyRegisterDomainResponse(r)).toEqual({ kind: "balance_pending" });
  });

  it("error message with 'please contact support' → balance_pending (RC's wrapper wording)", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Please contact support to enable this feature",
    };
    expect(classifyRegisterDomainResponse(r)).toEqual({ kind: "balance_pending" });
  });

  it("error message with processing-lock fragment → balance_pending (acts like pending)", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Order locked for processing",
    };
    expect(classifyRegisterDomainResponse(r)).toEqual({ kind: "balance_pending" });
  });

  it("error message with 'pending order' fragment → already_in_progress", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Pending order for this domain exists",
    };
    expect(classifyRegisterDomainResponse(r)).toEqual({
      kind: "already_in_progress",
    });
  });

  it("unmatched error → hard_failure with stamped status when no message", () => {
    const r: ResellerClubResponse = { status: "error" } as never;
    const result = classifyRegisterDomainResponse(r);
    expect(result.kind).toBe("hard_failure");
    if (result.kind === "hard_failure") {
      expect(result.reason).toContain("status=error");
    }
  });
});

describe("classifyRenewDomainResponse", () => {
  it("success + numeric price → renewed with the number", () => {
    const r: ResellerClubResponse = {
      status: "success",
      data: { orderid: "999", price: 12.5 },
    };
    expect(classifyRenewDomainResponse(r)).toEqual({
      kind: "renewed",
      orderId: "999",
      price: 12.5,
    });
  });

  it("success + string price → coerced to number", () => {
    const r: ResellerClubResponse = {
      status: "success",
      data: { orderid: "1", price: "23.75" },
    };
    expect(classifyRenewDomainResponse(r)).toMatchObject({ price: 23.75 });
  });

  it("success + non-numeric string price → undefined (NaN-guarded via Number.isFinite)", () => {
    const r: ResellerClubResponse = {
      status: "success",
      data: { orderid: "1", price: "free" },
    };
    const result = classifyRenewDomainResponse(r);
    expect(result.kind).toBe("renewed");
    if (result.kind === "renewed") {
      expect(result.price).toBeUndefined();
    }
  });

  it("'low funds' message → balance_pending (shared vocab with register)", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Low funds in reseller account",
    };
    expect(classifyRenewDomainResponse(r)).toEqual({ kind: "balance_pending" });
  });
});

describe("classifyGetDomainOrderIdResponse", () => {
  it("success + truthy data → found with stringified orderId", () => {
    const r: ResellerClubResponse = { status: "success", data: 555 };
    expect(classifyGetDomainOrderIdResponse(r)).toEqual({
      kind: "found",
      orderId: "555",
    });
  });

  it("RC returned success but literal 'undefined' string → not_found", () => {
    const r: ResellerClubResponse = { status: "success", data: "undefined" };
    expect(classifyGetDomainOrderIdResponse(r)).toMatchObject({
      kind: "not_found",
    });
  });

  it("'not found' message → not_found", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "No orders found for this domain",
    };
    expect(classifyGetDomainOrderIdResponse(r)).toMatchObject({
      kind: "not_found",
    });
  });

  it("unmatched error → hard_failure", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Random unhandled error",
    };
    expect(classifyGetDomainOrderIdResponse(r).kind).toBe("hard_failure");
  });
});

describe("classifyGetDomainDetailsResponse", () => {
  it("success + data → found with details cast", () => {
    const r: ResellerClubResponse = {
      status: "success",
      data: { domainname: "x.com", endtime: "1700000000" },
    };
    const result = classifyGetDomainDetailsResponse(r);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.details.domainname).toBe("x.com");
    }
  });

  it("'does not exist' → not_found", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Domain does not exist",
    };
    expect(classifyGetDomainDetailsResponse(r).kind).toBe("not_found");
  });
});

describe("classifyGetDNSRecordsResponse", () => {
  it("success + records[] → found with the array (empty is still 'found')", () => {
    const r: ResellerClubResponse = {
      status: "success",
      data: { records: [] },
    };
    expect(classifyGetDNSRecordsResponse(r)).toEqual({ kind: "found", records: [] });
  });

  it("success but records missing → found with [] (defensive Array.isArray)", () => {
    const r: ResellerClubResponse = { status: "success", data: {} };
    expect(classifyGetDNSRecordsResponse(r)).toEqual({ kind: "found", records: [] });
  });

  it("'no domain' message → not_found (reserved for 'not under DNS management')", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "No domain registered",
    };
    expect(classifyGetDNSRecordsResponse(r).kind).toBe("not_found");
  });
});

describe("classifyTransferDomainResponse", () => {
  it("success + entityid → transfer_initiated with stringified entityId", () => {
    const r: ResellerClubResponse = {
      status: "success",
      data: { entityid: 7777 },
    };
    expect(classifyTransferDomainResponse(r)).toEqual({
      kind: "transfer_initiated",
      entityId: "7777",
    });
  });

  it("EPP-code fragment → transfer_rejected", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Invalid EPP code provided",
    };
    expect(classifyTransferDomainResponse(r).kind).toBe("transfer_rejected");
  });

  it("60-day-lock fragment → transfer_rejected", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Domain inside 60-day post-registration lock",
    };
    expect(classifyTransferDomainResponse(r).kind).toBe("transfer_rejected");
  });

  it("clientTransferProhibited fragment → transfer_rejected", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Status: clientTransferProhibited",
    };
    expect(classifyTransferDomainResponse(r).kind).toBe("transfer_rejected");
  });

  it("balance fragment → balance_pending (NOT transfer_rejected — different recovery)", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Insufficient balance",
    };
    expect(classifyTransferDomainResponse(r).kind).toBe("balance_pending");
  });

  it("unmatched error → hard_failure", () => {
    const r: ResellerClubResponse = {
      status: "error",
      message: "Random uncategorized error",
    };
    expect(classifyTransferDomainResponse(r).kind).toBe("hard_failure");
  });
});
