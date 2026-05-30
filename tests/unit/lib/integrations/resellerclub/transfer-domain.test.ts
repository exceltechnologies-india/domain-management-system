/**
 * Tests for `@/lib/integrations/resellerclub/transfer-domain` (rescan-4
 * slice 7dk). Distinguishes registry-rejection (bad EPP code, transfer
 * lock, 60-day window) from generic hard failures. Pins:
 *  - All 4 args forwarded to the SDK (domainName + authCode + customerId
 *    + optional contacts)
 *  - hard_failure response → error log; transfer_rejected → warn log
 *  - Thrown error matching BALANCE_PENDING_FRAGMENTS → balance_pending
 *  - Thrown error matching TRANSFER_REJECTED_FRAGMENTS → transfer_rejected
 *  - Other thrown errors → hard_failure
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.RESELLERCLUB_API_URL = "https://test-api.resellerclub.example.com";
  process.env.RESELLERCLUB_ID = "test-id";
  process.env.RESELLERCLUB_SECRET = "test-secret";
});

const rcTransferMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { transferDomain: rcTransferMock },
}));

const loggerWarn = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: loggerWarn, error: loggerError, info: vi.fn() },
}));

import { transferDomain } from "@/lib/integrations/resellerclub/transfer-domain";

const BASE_INPUT = {
  domainName: "example.com",
  authCode: "EPP123",
  customerId: 42,
  contacts: { admin: 100, tech: 101, billing: 102 },
};

beforeEach(() => {
  rcTransferMock.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
});

describe("transferDomain wrapper", () => {
  it("forwards all 4 args to the SDK call (domainName + authCode + customerId + contacts)", async () => {
    rcTransferMock.mockResolvedValueOnce({
      status: "success",
      data: { entityid: "ord_42" },
    });
    await transferDomain(BASE_INPUT);
    expect(rcTransferMock).toHaveBeenCalledWith(
      "example.com",
      "EPP123",
      42,
      { admin: 100, tech: 101, billing: 102 }
    );
  });

  it("forwards undefined contacts when omitted", async () => {
    rcTransferMock.mockResolvedValueOnce({
      status: "success",
      data: { entityid: "ord_42" },
    });
    await transferDomain({
      domainName: "example.com",
      authCode: "EPP123",
      customerId: 42,
    });
    expect(rcTransferMock).toHaveBeenCalledWith("example.com", "EPP123", 42, undefined);
  });

  it("RC success → outcome.kind from classify (initiated path)", async () => {
    rcTransferMock.mockResolvedValueOnce({
      status: "success",
      data: { entityid: "ord_42" },
    });
    const result = await transferDomain(BASE_INPUT);
    // The exact kind ('initiated' or similar) is covered by classify.ts
    // tests — here we just pin that no error log was emitted.
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
    expect(result.kind).not.toBe("hard_failure");
  });

  it("transfer_rejected response → warn log emitted (not error)", async () => {
    // 'invalid epp' is in TRANSFER_REJECTED_FRAGMENTS verbatim.
    rcTransferMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "Invalid EPP code from registry",
    });
    const result = await transferDomain(BASE_INPUT);
    expect(result.kind).toBe("transfer_rejected");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("hard_failure response → error log emitted", async () => {
    rcTransferMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "Internal server error",
    });
    const result = await transferDomain(BASE_INPUT);
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("thrown error matching BALANCE_PENDING_FRAGMENTS → {kind:'balance_pending'}", async () => {
    rcTransferMock.mockRejectedValueOnce(new Error("Insufficient balance on reseller account"));
    const result = await transferDomain(BASE_INPUT);
    expect(result.kind).toBe("balance_pending");
    // Original throw is still logged before classification.
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("thrown error matching TRANSFER_REJECTED_FRAGMENTS → {kind:'transfer_rejected', reason}", async () => {
    // 'auth code' is in TRANSFER_REJECTED_FRAGMENTS (note: hyphenated 'Auth-Info'
    // does NOT match — fragments use 'auth code' / 'auth-code' / 'authcode').
    rcTransferMock.mockRejectedValueOnce(new Error("Invalid auth code at registry"));
    const result = await transferDomain(BASE_INPUT);
    expect(result.kind).toBe("transfer_rejected");
    if (result.kind === "transfer_rejected") {
      expect(result.reason).toMatch(/auth code/i);
    }
  });

  it("thrown error matching nothing → {kind:'hard_failure', reason}", async () => {
    rcTransferMock.mockRejectedValueOnce(new Error("Network unreachable"));
    const result = await transferDomain(BASE_INPUT);
    expect(result.kind).toBe("hard_failure");
    if (result.kind === "hard_failure") {
      expect(result.reason).toMatch(/unreachable/);
    }
  });

  it("non-Error throws still classified via String() coercion", async () => {
    rcTransferMock.mockRejectedValueOnce("plain string error");
    const result = await transferDomain(BASE_INPUT);
    expect(result.kind).toBe("hard_failure");
  });
});
