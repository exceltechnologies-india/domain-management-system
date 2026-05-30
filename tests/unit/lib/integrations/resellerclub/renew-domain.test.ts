/**
 * Tests for `@/lib/integrations/resellerclub/renew-domain` (rescan-4
 * slice 7dj). Pins:
 *  - RC success → outcome from classify (renewed shape)
 *  - hard_failure response → error log
 *  - thrown error with BALANCE_PENDING_FRAGMENTS message → balance_pending
 *    (no other branch swallows balance failures; this short-circuit
 *    keeps the cron-retry path working when the SDK throws instead of
 *    returning {status:"error"})
 *  - other thrown errors → hard_failure with the message
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.RESELLERCLUB_API_URL = "https://test-api.resellerclub.example.com";
  process.env.RESELLERCLUB_ID = "test-id";
  process.env.RESELLERCLUB_SECRET = "test-secret";
});

const rcRenewMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { renewDomain: rcRenewMock },
}));

const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: loggerError, info: vi.fn(), warn: vi.fn() },
}));

import { renewDomain } from "@/lib/integrations/resellerclub/renew-domain";

beforeEach(() => {
  rcRenewMock.mockReset();
  loggerError.mockReset();
});

describe("renewDomain wrapper", () => {
  it("RC success with order-id → {kind:'renewed', orderId, ...}", async () => {
    rcRenewMock.mockResolvedValueOnce({
      status: "success",
      data: { entityid: "ord_42", sellingprice: 1200, currencysymbol: "INR" },
    });
    const result = await renewDomain({ domainName: "example.com", years: 1 });
    expect(result.kind).toBe("renewed");
    expect(rcRenewMock).toHaveBeenCalledWith("example.com", 1);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("hard_failure response → error log emitted", async () => {
    rcRenewMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "Order is locked by registry",
    });
    const result = await renewDomain({ domainName: "example.com", years: 1 });
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatch(/example\.com/);
  });

  it("thrown error matching BALANCE_PENDING_FRAGMENTS → {kind:'balance_pending'} (no hard_failure)", async () => {
    // 'insufficient balance' is in BALANCE_PENDING_FRAGMENTS verbatim.
    rcRenewMock.mockRejectedValueOnce(new Error("Insufficient balance on reseller account"));
    const result = await renewDomain({ domainName: "example.com", years: 1 });
    expect(result.kind).toBe("balance_pending");
    // Error is still logged before classification.
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("thrown error not matching balance fragments → {kind:'hard_failure', reason}", async () => {
    rcRenewMock.mockRejectedValueOnce(new Error("Request failed with status 500"));
    const result = await renewDomain({ domainName: "example.com", years: 1 });
    expect(result.kind).toBe("hard_failure");
    if (result.kind === "hard_failure") {
      expect(result.reason).toMatch(/status 500/);
    }
    expect(loggerError).toHaveBeenCalled();
  });

  it("thrown non-Error value still classifies (String coercion)", async () => {
    rcRenewMock.mockRejectedValueOnce("plain string error");
    const result = await renewDomain({ domainName: "example.com", years: 1 });
    expect(result.kind).toBe("hard_failure");
  });

  it("forwards the years arg through to the SDK call", async () => {
    rcRenewMock.mockResolvedValueOnce({
      status: "success",
      data: { entityid: "ord_42", sellingprice: 1200, currencysymbol: "INR" },
    });
    await renewDomain({ domainName: "example.com", years: 5 });
    expect(rcRenewMock).toHaveBeenCalledWith("example.com", 5);
  });
});
