/**
 * Tests for `@/lib/integrations/resellerclub/get-domain-order-id`
 * (rescan-4 slice 7dh). The wrapper delegates to ResellerClubWrapper +
 * classifyGetDomainOrderIdResponse and logs at info/error per outcome.
 * Pins the delegation contract; outcome shape is covered exhaustively by
 * the classify.ts tests in earlier slices.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.RESELLERCLUB_API_URL = "https://test-api.resellerclub.example.com";
  process.env.RESELLERCLUB_ID = "test-id";
  process.env.RESELLERCLUB_SECRET = "test-secret";
});

const rcGetOrderIdMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { getDomainOrderId: rcGetOrderIdMock },
}));

const loggerInfo = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: loggerInfo, error: loggerError, warn: vi.fn() },
}));

import { getDomainOrderId } from "@/lib/integrations/resellerclub/get-domain-order-id";

beforeEach(() => {
  rcGetOrderIdMock.mockReset();
  loggerInfo.mockReset();
  loggerError.mockReset();
});

describe("getDomainOrderId wrapper", () => {
  it("RC success with order-id → {kind:'found', orderId}", async () => {
    rcGetOrderIdMock.mockResolvedValueOnce({ status: "success", data: "ord_42" });
    const result = await getDomainOrderId({ domainName: "example.com" });
    expect(result).toEqual({ kind: "found", orderId: "ord_42" });
    expect(rcGetOrderIdMock).toHaveBeenCalledWith("example.com");
    // No log emitted on the happy path.
    expect(loggerInfo).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("RC success but data stringifies to 'null' → {kind:'not_found'} + info log", async () => {
    // Truthy data that stringifies to "null" hits the empty-order-id branch.
    rcGetOrderIdMock.mockResolvedValueOnce({ status: "success", data: "null" });
    const result = await getDomainOrderId({ domainName: "example.com" });
    expect(result.kind).toBe("not_found");
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    expect(loggerInfo.mock.calls[0][0]).toMatch(/example\.com/);
  });

  it("RC 'not found' message → not_found + info log", async () => {
    rcGetOrderIdMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "No matching order found for this domain",
    });
    const result = await getDomainOrderId({ domainName: "example.com" });
    expect(result.kind).toBe("not_found");
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("RC generic error → hard_failure + error log", async () => {
    rcGetOrderIdMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "Internal Server Error",
    });
    const result = await getDomainOrderId({ domainName: "example.com" });
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatch(/hard_failure/);
  });
});
