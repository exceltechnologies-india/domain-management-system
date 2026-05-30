/**
 * Tests for `@/lib/integrations/resellerclub/register-domain` (rescan-4
 * slice 7dl). Wrapper around ResellerClubWrapper.registerDomain that
 * maps both responses AND thrown exceptions onto RegisterDomainOutcome.
 * Pins:
 *  - All 6 args forwarded to the SDK
 *  - RC success → outcome via classify (registered)
 *  - hard_failure response → error log
 *  - Thrown error matching BALANCE_PENDING_FRAGMENTS → balance_pending
 *    short-circuit
 *  - Other thrown errors → hard_failure
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.RESELLERCLUB_API_URL = "https://test-api.resellerclub.example.com";
  process.env.RESELLERCLUB_ID = "test-id";
  process.env.RESELLERCLUB_SECRET = "test-secret";
});

const rcRegisterMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { registerDomain: rcRegisterMock },
}));

const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: loggerError, warn: vi.fn(), info: vi.fn() },
}));

import { registerDomain } from "@/lib/integrations/resellerclub/register-domain";

const BASE_INPUT = {
  domainName: "example.com",
  years: 1,
  customerId: 42,
  nameServers: ["ns1.example.com", "ns2.example.com"],
  contacts: { admin: 100, tech: 101, billing: 102 },
  tldAttributes: { acceptTerms: "1" },
};

beforeEach(() => {
  rcRegisterMock.mockReset();
  loggerError.mockReset();
});

describe("registerDomain wrapper", () => {
  it("forwards all 6 args to the SDK call in order", async () => {
    rcRegisterMock.mockResolvedValueOnce({
      status: "success",
      data: { entityid: "ord_42" },
    });
    await registerDomain(BASE_INPUT);
    expect(rcRegisterMock).toHaveBeenCalledWith(
      "example.com",
      1,
      42,
      ["ns1.example.com", "ns2.example.com"],
      { admin: 100, tech: 101, billing: 102 },
      { acceptTerms: "1" }
    );
  });

  it("forwards undefined for optional args when omitted", async () => {
    rcRegisterMock.mockResolvedValueOnce({
      status: "success",
      data: { entityid: "ord_42" },
    });
    await registerDomain({
      domainName: "example.com",
      years: 1,
      customerId: 42,
    });
    expect(rcRegisterMock).toHaveBeenCalledWith(
      "example.com",
      1,
      42,
      undefined,
      undefined,
      undefined
    );
  });

  it("RC success → outcome from classify (registered) + no error log", async () => {
    rcRegisterMock.mockResolvedValueOnce({
      status: "success",
      data: { entityid: "ord_42" },
    });
    const result = await registerDomain(BASE_INPUT);
    expect(result.kind).not.toBe("hard_failure");
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("hard_failure response → error log emitted", async () => {
    rcRegisterMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "Domain registration is not allowed for this TLD",
    });
    const result = await registerDomain(BASE_INPUT);
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("thrown error matching BALANCE_PENDING_FRAGMENTS → balance_pending short-circuit", async () => {
    rcRegisterMock.mockRejectedValueOnce(
      new Error("Insufficient balance on reseller account")
    );
    const result = await registerDomain(BASE_INPUT);
    expect(result.kind).toBe("balance_pending");
    // Throw is logged at error before classification.
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("thrown non-balance error → hard_failure with message preserved", async () => {
    rcRegisterMock.mockRejectedValueOnce(new Error("Network unreachable"));
    const result = await registerDomain(BASE_INPUT);
    expect(result.kind).toBe("hard_failure");
    if (result.kind === "hard_failure") {
      expect(result.reason).toMatch(/unreachable/);
    }
  });

  it("non-Error throws coerced via String()", async () => {
    rcRegisterMock.mockRejectedValueOnce("plain string error");
    const result = await registerDomain(BASE_INPUT);
    expect(result.kind).toBe("hard_failure");
  });
});
