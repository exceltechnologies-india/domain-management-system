/**
 * Tests for `@/lib/integrations/resellerclub/get-dns-records`
 * (rescan-4 slice 7dh). Read op — same delegation pattern. Pins the
 * input arity (domainName + customerId).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.RESELLERCLUB_API_URL = "https://test-api.resellerclub.example.com";
  process.env.RESELLERCLUB_ID = "test-id";
  process.env.RESELLERCLUB_SECRET = "test-secret";
});

const rcGetDnsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { getDNSRecords: rcGetDnsMock },
}));

const loggerInfo = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: loggerInfo, error: loggerError, warn: vi.fn() },
}));

import { getDNSRecords } from "@/lib/integrations/resellerclub/get-dns-records";

beforeEach(() => {
  rcGetDnsMock.mockReset();
  loggerInfo.mockReset();
  loggerError.mockReset();
});

describe("getDNSRecords wrapper", () => {
  it("forwards domainName + customerId to the underlying SDK", async () => {
    rcGetDnsMock.mockResolvedValueOnce({
      status: "success",
      data: { A: [{ host: "@", value: "1.2.3.4" }] },
    });
    await getDNSRecords({ domainName: "example.com", customerId: "cust-42" });
    expect(rcGetDnsMock).toHaveBeenCalledWith("example.com", "cust-42");
  });

  it("RC success → {kind:'found', records}", async () => {
    rcGetDnsMock.mockResolvedValueOnce({
      status: "success",
      data: { A: [{ host: "@", value: "1.2.3.4" }] },
    });
    const result = await getDNSRecords({
      domainName: "example.com",
      customerId: "c1",
    });
    expect(result.kind).toBe("found");
  });

  it("RC 'no records found' message → not_found + info log", async () => {
    rcGetDnsMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "Request failed with status code 404",
    });
    const result = await getDNSRecords({ domainName: "example.com", customerId: "c1" });
    expect(result.kind).toBe("not_found");
    expect(loggerInfo).toHaveBeenCalledTimes(1);
  });

  it("RC unknown error → hard_failure + error log", async () => {
    rcGetDnsMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "Authentication failed",
    });
    const result = await getDNSRecords({ domainName: "example.com", customerId: "c1" });
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
