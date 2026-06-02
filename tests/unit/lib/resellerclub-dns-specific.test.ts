/**
 * Tests for `@/lib/resellerclub-dns-specific` (rescan-4 slice 7ey).
 * The 23-method ResellerClubDNSSpecific class — one method per RC
 * DNS endpoint (1 search + 7 adds + 7 modifies + 7 deletes + 1 SOA
 * modify). The shapes are highly regular; parametrised it.each tests
 * cover each endpoint + per-record-type params + error wrap.
 * Pins:
 *  - searchDNSRecords GETs `/api/dns/manage/search-records.json`;
 *    404 → 'Request failed with status code 404' literal (legacy
 *    caller-message that callers grep for); other errors →
 *    'Failed to search DNS records'
 *  - All 7 add methods POST `/api/dns/manage/add-{TYPE}-record.json`
 *    with domain-name + host + value + ttl; MX adds priority; SRV
 *    adds priority + weight + port
 *  - All 7 modify methods POST `/api/dns/manage/modify-{TYPE}-record.json`
 *    with the record-id + the same per-type params
 *  - All 7 delete methods POST `/api/dns/manage/delete-{TYPE}-record.json`
 *    with ONLY domain-name + record-id (no value/ttl needed — RC
 *    looks up by record-id)
 *  - modifySOARecord has its own special 8-field param set (no
 *    record-id; SOA is singleton per zone)
 *  - Each method wraps API throws into its own typed error message
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiInstance = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  },
}));
const axiosCreate = vi.hoisted(() => vi.fn(() => apiInstance));

vi.mock("axios", async () => {
  const actual = await vi.importActual<typeof import("axios")>("axios");
  return {
    default: { create: axiosCreate },
    AxiosError: actual.AxiosError,
  };
});

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { ResellerClubDNSSpecific } from "@/lib/resellerclub-dns-specific";

beforeEach(() => {
  apiInstance.get.mockReset();
  apiInstance.post.mockReset();
});

describe("searchDNSRecords", () => {
  it("GETs /api/dns/manage/search-records.json with domain-name + customer-id", async () => {
    apiInstance.get.mockResolvedValueOnce({ data: { records: [] } });
    await ResellerClubDNSSpecific.searchDNSRecords("x.com", "C7");
    expect(apiInstance.get).toHaveBeenCalledWith(
      "/api/dns/manage/search-records.json",
      { params: { "domain-name": "x.com", "customer-id": "C7" } }
    );
  });

  it("404 error → literal 'Request failed with status code 404' (callers grep for it)", async () => {
    const { AxiosError } = await import("axios");
    const err = new AxiosError("Request failed", "ERR_BAD_REQUEST");
    err.response = { status: 404, statusText: "", headers: {}, config: {} as never, data: {} };
    apiInstance.get.mockRejectedValueOnce(err);
    const result = await ResellerClubDNSSpecific.searchDNSRecords("x.com", "C7");
    expect(result.message).toBe("Request failed with status code 404");
  });

  it("non-404 error → 'Failed to search DNS records' sentinel", async () => {
    apiInstance.get.mockRejectedValueOnce(new Error("503"));
    const result = await ResellerClubDNSSpecific.searchDNSRecords("x.com", "C7");
    expect(result).toEqual({
      status: "error",
      message: "Failed to search DNS records",
    });
  });
});

describe("add* methods — 7 endpoints", () => {
  const ipv4Like = { host: "@", value: "1.2.3.4", ttl: 14400 };

  const cases = [
    {
      fn: () => ResellerClubDNSSpecific.addIPv4Record("x.com", ipv4Like),
      endpoint: "/api/dns/manage/add-ipv4-record.json",
      errMsg: /Failed to add IPv4 record/,
      extraParams: {},
    },
    {
      fn: () => ResellerClubDNSSpecific.addIPv6Record("x.com", ipv4Like),
      endpoint: "/api/dns/manage/add-ipv6-record.json",
      errMsg: /Failed to add IPv6 record/,
      extraParams: {},
    },
    {
      fn: () => ResellerClubDNSSpecific.addCNAMERecord("x.com", ipv4Like),
      endpoint: "/api/dns/manage/add-cname-record.json",
      errMsg: /Failed to add CNAME record/,
      extraParams: {},
    },
    {
      fn: () =>
        ResellerClubDNSSpecific.addMXRecord("x.com", {
          ...ipv4Like,
          priority: 10,
        }),
      endpoint: "/api/dns/manage/add-mx-record.json",
      errMsg: /Failed to add MX record/,
      extraParams: { priority: 10 },
    },
    {
      fn: () => ResellerClubDNSSpecific.addNSRecord("x.com", ipv4Like),
      endpoint: "/api/dns/manage/add-ns-record.json",
      errMsg: /Failed to add NS record/,
      extraParams: {},
    },
    {
      fn: () => ResellerClubDNSSpecific.addTXTRecord("x.com", ipv4Like),
      endpoint: "/api/dns/manage/add-txt-record.json",
      errMsg: /Failed to add TXT record/,
      extraParams: {},
    },
    {
      fn: () =>
        ResellerClubDNSSpecific.addSRVRecord("x.com", {
          ...ipv4Like,
          priority: 10,
          weight: 5,
          port: 443,
        }),
      endpoint: "/api/dns/manage/add-srv-record.json",
      errMsg: /Failed to add SRV record/,
      extraParams: { priority: 10, weight: 5, port: 443 },
    },
  ];

  it.each(cases)("$endpoint: POSTs with per-record-type params", async (c) => {
    apiInstance.post.mockResolvedValueOnce({ data: { ok: true } });
    await c.fn();
    expect(apiInstance.post).toHaveBeenCalledWith(c.endpoint, null, {
      params: expect.objectContaining({
        "domain-name": "x.com",
        host: "@",
        value: "1.2.3.4",
        ttl: 14400,
        ...c.extraParams,
      }),
    });
  });

  it.each(cases)("$endpoint: error → typed sentinel $errMsg", async (c) => {
    apiInstance.post.mockRejectedValueOnce(new Error("503"));
    const result = await c.fn();
    expect(result.status).toBe("error");
    expect(result.message).toMatch(c.errMsg);
  });
});

describe("modify* methods — 7 endpoints + record-id param", () => {
  const ipv4Like = { host: "@", value: "1.2.3.4", ttl: 14400 };

  const cases = [
    {
      fn: () => ResellerClubDNSSpecific.modifyIPv4Record("x.com", "R1", ipv4Like),
      endpoint: "/api/dns/manage/modify-ipv4-record.json",
      errMsg: /Failed to modify IPv4 record/,
      extraParams: {},
    },
    {
      fn: () => ResellerClubDNSSpecific.modifyIPv6Record("x.com", "R1", ipv4Like),
      endpoint: "/api/dns/manage/modify-ipv6-record.json",
      errMsg: /Failed to modify IPv6 record/,
      extraParams: {},
    },
    {
      fn: () => ResellerClubDNSSpecific.modifyCNAMERecord("x.com", "R1", ipv4Like),
      endpoint: "/api/dns/manage/modify-cname-record.json",
      errMsg: /Failed to modify CNAME record/,
      extraParams: {},
    },
    {
      fn: () =>
        ResellerClubDNSSpecific.modifyMXRecord("x.com", "R1", {
          ...ipv4Like,
          priority: 10,
        }),
      endpoint: "/api/dns/manage/modify-mx-record.json",
      errMsg: /Failed to modify MX record/,
      extraParams: { priority: 10 },
    },
    {
      fn: () => ResellerClubDNSSpecific.modifyNSRecord("x.com", "R1", ipv4Like),
      endpoint: "/api/dns/manage/modify-ns-record.json",
      errMsg: /Failed to modify NS record/,
      extraParams: {},
    },
    {
      fn: () => ResellerClubDNSSpecific.modifyTXTRecord("x.com", "R1", ipv4Like),
      endpoint: "/api/dns/manage/modify-txt-record.json",
      errMsg: /Failed to modify TXT record/,
      extraParams: {},
    },
    {
      fn: () =>
        ResellerClubDNSSpecific.modifySRVRecord("x.com", "R1", {
          ...ipv4Like,
          priority: 10,
          weight: 5,
          port: 443,
        }),
      endpoint: "/api/dns/manage/modify-srv-record.json",
      errMsg: /Failed to modify SRV record/,
      extraParams: { priority: 10, weight: 5, port: 443 },
    },
  ];

  it.each(cases)("$endpoint: POSTs with record-id + per-type params", async (c) => {
    apiInstance.post.mockResolvedValueOnce({ data: { ok: true } });
    await c.fn();
    expect(apiInstance.post).toHaveBeenCalledWith(c.endpoint, null, {
      params: expect.objectContaining({
        "domain-name": "x.com",
        "record-id": "R1",
        host: "@",
        value: "1.2.3.4",
        ttl: 14400,
        ...c.extraParams,
      }),
    });
  });

  it.each(cases)("$endpoint: error → $errMsg", async (c) => {
    apiInstance.post.mockRejectedValueOnce(new Error("503"));
    const result = await c.fn();
    expect(result.message).toMatch(c.errMsg);
  });
});

describe("modifySOARecord — 8-field special case (singleton per zone, no record-id)", () => {
  it("POSTs /api/dns/manage/modify-soa-record.json with all 8 SOA fields + no record-id", async () => {
    apiInstance.post.mockResolvedValueOnce({ data: { ok: true } });
    await ResellerClubDNSSpecific.modifySOARecord("x.com", {
      ttl: 3600,
      primary_ns: "ns1.x.com",
      resp_person: "admin.x.com",
      serial: 2026060201,
      refresh: 86400,
      retry: 3600,
      expire: 604800,
      minimum: 86400,
    });
    expect(apiInstance.post).toHaveBeenCalledWith(
      "/api/dns/manage/modify-soa-record.json",
      null,
      {
        params: {
          "domain-name": "x.com",
          ttl: 3600,
          primary_ns: "ns1.x.com",
          resp_person: "admin.x.com",
          serial: 2026060201,
          refresh: 86400,
          retry: 3600,
          expire: 604800,
          minimum: 86400,
        },
      }
    );
  });

  it("error → 'Failed to modify SOA record' sentinel", async () => {
    apiInstance.post.mockRejectedValueOnce(new Error("503"));
    const result = await ResellerClubDNSSpecific.modifySOARecord("x.com", {
      ttl: 3600,
      primary_ns: "ns1.x.com",
      resp_person: "admin.x.com",
      serial: 1,
      refresh: 1,
      retry: 1,
      expire: 1,
      minimum: 1,
    });
    expect(result.message).toBe("Failed to modify SOA record");
  });
});

describe("delete* methods — 7 endpoints + record-id only (no value/ttl)", () => {
  const cases = [
    {
      fn: () => ResellerClubDNSSpecific.deleteIPv4Record("x.com", "R1"),
      endpoint: "/api/dns/manage/delete-ipv4-record.json",
      errMsg: /Failed to delete IPv4 record/,
    },
    {
      fn: () => ResellerClubDNSSpecific.deleteIPv6Record("x.com", "R1"),
      endpoint: "/api/dns/manage/delete-ipv6-record.json",
      errMsg: /Failed to delete IPv6 record/,
    },
    {
      fn: () => ResellerClubDNSSpecific.deleteCNAMERecord("x.com", "R1"),
      endpoint: "/api/dns/manage/delete-cname-record.json",
      errMsg: /Failed to delete CNAME record/,
    },
    {
      fn: () => ResellerClubDNSSpecific.deleteMXRecord("x.com", "R1"),
      endpoint: "/api/dns/manage/delete-mx-record.json",
      errMsg: /Failed to delete MX record/,
    },
    {
      fn: () => ResellerClubDNSSpecific.deleteNSRecord("x.com", "R1"),
      endpoint: "/api/dns/manage/delete-ns-record.json",
      errMsg: /Failed to delete NS record/,
    },
    {
      fn: () => ResellerClubDNSSpecific.deleteTXTRecord("x.com", "R1"),
      endpoint: "/api/dns/manage/delete-txt-record.json",
      errMsg: /Failed to delete TXT record/,
    },
    {
      fn: () => ResellerClubDNSSpecific.deleteSRVRecord("x.com", "R1"),
      endpoint: "/api/dns/manage/delete-srv-record.json",
      errMsg: /Failed to delete SRV record/,
    },
  ];

  it.each(cases)("$endpoint: only domain-name + record-id", async (c) => {
    apiInstance.post.mockResolvedValueOnce({ data: { ok: true } });
    await c.fn();
    expect(apiInstance.post).toHaveBeenCalledWith(c.endpoint, null, {
      params: { "domain-name": "x.com", "record-id": "R1" },
    });
  });

  it.each(cases)("$endpoint: error → $errMsg", async (c) => {
    apiInstance.post.mockRejectedValueOnce(new Error("503"));
    const result = await c.fn();
    expect(result.message).toMatch(c.errMsg);
  });
});
