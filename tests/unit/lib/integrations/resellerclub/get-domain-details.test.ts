/**
 * Tests for `@/lib/integrations/resellerclub/get-domain-details`
 * (rescan-4 slice 7dh). Same delegation pattern as the other RC read-ops.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.RESELLERCLUB_API_URL = "https://test-api.resellerclub.example.com";
  process.env.RESELLERCLUB_ID = "test-id";
  process.env.RESELLERCLUB_SECRET = "test-secret";
});

const rcGetDetailsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { getDomainDetails: rcGetDetailsMock },
}));

const loggerInfo = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: loggerInfo, error: loggerError, warn: vi.fn() },
}));

import { getDomainDetails } from "@/lib/integrations/resellerclub/get-domain-details";

beforeEach(() => {
  rcGetDetailsMock.mockReset();
  loggerInfo.mockReset();
  loggerError.mockReset();
});

describe("getDomainDetails wrapper", () => {
  it("RC success with record data → {kind:'found', details}", async () => {
    rcGetDetailsMock.mockResolvedValueOnce({
      status: "success",
      data: { domainname: "example.com", endtime: "2099-12-31" },
    });
    const result = await getDomainDetails({ domainName: "example.com" });
    expect(result.kind).toBe("found");
    expect(rcGetDetailsMock).toHaveBeenCalledWith("example.com");
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it("RC 'no orders found' message → not_found + info log", async () => {
    // 'no orders found' is in READ_NOT_FOUND_FRAGMENTS verbatim.
    rcGetDetailsMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "No orders found for this domain",
    });
    const result = await getDomainDetails({ domainName: "example.com" });
    expect(result.kind).toBe("not_found");
    expect(loggerInfo).toHaveBeenCalledTimes(1);
  });

  it("RC generic failure → hard_failure + error log", async () => {
    rcGetDetailsMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "Internal Server Error",
    });
    const result = await getDomainDetails({ domainName: "example.com" });
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
