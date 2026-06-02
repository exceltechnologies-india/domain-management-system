/**
 * Tests for `@/lib/resellerclub/dns` (rescan-4 slice 7es).
 * RC DNS record CRUD + nameserver helpers. Pins:
 *  - activateDNSManagement POSTs `/api/dns/activate.json` with
 *    domain-name + order-id
 *  - **getDNSRecords queries 7 record types in parallel SERIAL** (A,
 *    AAAA, CNAME, MX, NS, TXT, SRV), one HTTP per type; failures on
 *    individual types are SWALLOWED (continue with other types) so a
 *    domain with only A+TXT records still returns them
 *  - getDNSRecords numbered-key collection: RC returns
 *    `{1: {...}, 2: {...}, recsonpage: N, recsindb: N}` — keys
 *    'recsonpage' + 'recsindb' filtered OUT; each numbered key maps
 *    through with id/ttl/name normalisation (recordid/recordId/'record-id'
 *    → id; timetolive/ttl → ttl; host/name → name)
 *  - **addDNSRecord 7-way endpoint switch + per-type extras**:
 *    A → add-ipv4-record; AAAA → add-ipv6; CNAME → add-cname; MX → MX
 *    + params.priority (default 10); NS → ns; TXT → txt; SRV → srv +
 *    priority + weight=10 + port=443 defaults
 *  - addDNSRecord **TTL floored to 7200** (RC minimum)
 *  - addDNSRecord **host normalization**: `@` → domainName, else passes through
 *  - addDNSRecord unsupported type → error sentinel WITHOUT a POST
 *  - addDNSRecord AxiosError extracts response.data.msg field
 *  - updateDNSRecord POSTs `/api/dns/manage/modify-record.json`;
 *    host @ → domainName normalisation; priority passes through (even
 *    when undefined — let RC apply its own default)
 *  - deleteDNSRecord POSTs `/api/dns/manage/delete-record.json` with
 *    record-id + the record's host/value/type echoed back
 *  - **setDefaultNameservers delegates to setCustomNameservers** with
 *    the 4 hardcoded deepak1299294.* nameservers
 *  - setCustomNameservers paramsSerializer fans the ns array into
 *    repeated `ns=...` params (custom URLSearchParams serializer)
 *  - getNameservers: 2-step lookup (getDomainOrderId → details.json
 *    with options:NsDetails); collects ns1..ns13 dynamically; returns
 *    [] when order-id lookup fails or when no ns fields present
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AxiosError } from "axios";

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub/client", () => ({
  api: { get: apiGet, post: apiPost },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const getDomainOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub/registration", () => ({ getDomainOrderId }));

import {
  activateDNSManagement,
  getDNSRecords,
  addDNSRecord,
  updateDNSRecord,
  deleteDNSRecord,
  setDefaultNameservers,
  setCustomNameservers,
  getNameservers,
} from "@/lib/resellerclub/dns";

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  getDomainOrderId.mockReset();
});

describe("activateDNSManagement", () => {
  it("POSTs /api/dns/activate.json with domain-name + order-id", async () => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await activateDNSManagement("x.com", "ORD_42");
    expect(apiPost).toHaveBeenCalledWith("/api/dns/activate.json", null, {
      params: { "domain-name": "x.com", "order-id": "ORD_42" },
    });
  });

  it("axios throw → 'Failed to activate DNS management' sentinel", async () => {
    apiPost.mockRejectedValueOnce(new Error("503"));
    const result = await activateDNSManagement("x.com", "ORD");
    expect(result).toEqual({
      status: "error",
      message: "Failed to activate DNS management",
    });
  });
});

describe("getDNSRecords — 7-type parallel fetch + numbered-key collection", () => {
  it("queries all 7 record types (A/AAAA/CNAME/MX/NS/TXT/SRV) — one GET each", async () => {
    apiGet.mockResolvedValue({ data: {} });
    await getDNSRecords("x.com", "C7");
    expect(apiGet).toHaveBeenCalledTimes(7);
    const calledTypes = apiGet.mock.calls.map((c) => c[1].params.type);
    expect(calledTypes).toEqual(["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV"]);
  });

  it("numbered-key collection: '1'/'2' kept, 'recsonpage'/'recsindb' filtered out", async () => {
    apiGet.mockResolvedValueOnce({
      data: {
        "1": {
          type: "A",
          recordid: "R1",
          value: "1.2.3.4",
          host: "@",
          timetolive: "3600",
        },
        "2": {
          type: "A",
          recordid: "R2",
          value: "5.6.7.8",
          host: "www",
          timetolive: "3600",
        },
        recsonpage: "2",
        recsindb: "5",
      },
    });
    // Subsequent type fetches return empty.
    apiGet.mockResolvedValue({ data: { recsonpage: "0" } });
    const result = await getDNSRecords("x.com", "C7");
    expect(result.status).toBe("success");
    const records = (result.data as { records: Array<{ id: string }> }).records;
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe("R1");
    expect(records[1].id).toBe("R2");
  });

  it("id fallback chain: recordid > recordId > 'record-id' > numbered key", async () => {
    apiGet.mockResolvedValueOnce({
      data: {
        "1": { type: "A", recordId: "FROM_recordId" },
        "2": { type: "A", "record-id": "FROM_record-id" },
        "3": { type: "A" }, // No id field → uses the key '3'
      },
    });
    apiGet.mockResolvedValue({ data: {} });
    const result = await getDNSRecords("x.com", "C7");
    const records = (result.data as { records: Array<{ id: string }> }).records;
    expect(records[0].id).toBe("FROM_recordId");
    expect(records[1].id).toBe("FROM_record-id");
    expect(records[2].id).toBe("3");
  });

  it("ttl + name normalisation: timetolive → ttl, host → name", async () => {
    apiGet.mockResolvedValueOnce({
      data: { "1": { type: "A", timetolive: "7200", host: "mail" } },
    });
    apiGet.mockResolvedValue({ data: {} });
    const result = await getDNSRecords("x.com", "C7");
    const records = (result.data as { records: Array<{ ttl: string; name: string }> }).records;
    expect(records[0].ttl).toBe("7200");
    expect(records[0].name).toBe("mail");
  });

  it("individual-type failure SWALLOWED — domain with partial records still returns them", async () => {
    apiGet
      .mockResolvedValueOnce({ data: { "1": { type: "A" } } }) // A
      .mockRejectedValueOnce(new Error("404 AAAA")) // AAAA throws
      .mockResolvedValue({ data: {} }); // rest empty
    const result = await getDNSRecords("x.com", "C7");
    expect(result.status).toBe("success");
    expect((result.data as { records: unknown[] }).records).toHaveLength(1);
  });
});

describe("addDNSRecord — 7-way endpoint switch", () => {
  const cases = [
    {
      type: "A",
      endpoint: "/api/dns/manage/add-ipv4-record.json",
      hasPriority: false,
    },
    {
      type: "AAAA",
      endpoint: "/api/dns/manage/add-ipv6-record.json",
      hasPriority: false,
    },
    {
      type: "CNAME",
      endpoint: "/api/dns/manage/add-cname-record.json",
      hasPriority: false,
    },
    {
      type: "MX",
      endpoint: "/api/dns/manage/add-mx-record.json",
      hasPriority: true,
    },
    {
      type: "NS",
      endpoint: "/api/dns/manage/add-ns-record.json",
      hasPriority: false,
    },
    {
      type: "TXT",
      endpoint: "/api/dns/manage/add-txt-record.json",
      hasPriority: false,
    },
  ];

  it.each(cases)("$type → POST $endpoint (priority param: $hasPriority)", async (c) => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await addDNSRecord("x.com", "C7", {
      type: c.type,
      name: "sub",
      value: "v",
      ttl: 7200,
    });
    const [url, , opts] = apiPost.mock.calls[0];
    expect(url).toBe(c.endpoint);
    if (c.hasPriority) {
      expect(opts.params.priority).toBe(10); // default
    } else {
      expect(opts.params.priority).toBeUndefined();
    }
  });

  it("SRV: endpoint /add-srv-record.json with priority/weight/port defaults", async () => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await addDNSRecord("x.com", "C7", {
      type: "SRV",
      name: "_sip",
      value: "host",
      ttl: 7200,
    });
    const [url, , opts] = apiPost.mock.calls[0];
    expect(url).toBe("/api/dns/manage/add-srv-record.json");
    expect(opts.params.priority).toBe(10);
    expect(opts.params.weight).toBe(10);
    expect(opts.params.port).toBe(443);
  });

  it("custom MX priority passed through (overrides default 10)", async () => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await addDNSRecord("x.com", "C7", {
      type: "MX",
      name: "@",
      value: "mail.x.com",
      ttl: 7200,
      priority: 50,
    });
    expect(apiPost.mock.calls[0][2].params.priority).toBe(50);
  });

  it("TTL FLOORED to 7200 (RC minimum) — request with ttl=60 sends ttl=7200", async () => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await addDNSRecord("x.com", "C7", {
      type: "A",
      name: "www",
      value: "1.2.3.4",
      ttl: 60,
    });
    expect(apiPost.mock.calls[0][2].params.ttl).toBe(7200);
  });

  it("TTL above 7200 passes through unchanged", async () => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await addDNSRecord("x.com", "C7", {
      type: "A",
      name: "www",
      value: "1.2.3.4",
      ttl: 86400,
    });
    expect(apiPost.mock.calls[0][2].params.ttl).toBe(86400);
  });

  it("host normalization: '@' → domainName, else passes through", async () => {
    apiPost.mockResolvedValue({ data: { ok: true } });
    await addDNSRecord("x.com", "C7", {
      type: "A",
      name: "@",
      value: "1.2.3.4",
      ttl: 7200,
    });
    expect(apiPost.mock.calls[0][2].params.host).toBe("x.com");

    await addDNSRecord("x.com", "C7", {
      type: "A",
      name: "www",
      value: "1.2.3.4",
      ttl: 7200,
    });
    expect(apiPost.mock.calls[1][2].params.host).toBe("www");
  });

  it("unsupported type → error sentinel WITHOUT making a POST", async () => {
    const result = await addDNSRecord("x.com", "C7", {
      type: "INVALID",
      name: "x",
      value: "v",
      ttl: 7200,
    });
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/Unsupported DNS record type: INVALID/);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("AxiosError extracts response.data.msg field for caller", async () => {
    const err = new AxiosError("Request failed", "ERR_BAD_REQUEST");
    err.response = {
      status: 400,
      statusText: "",
      headers: {},
      config: {} as never,
      data: { msg: "Duplicate record" },
    };
    apiPost.mockRejectedValueOnce(err);
    const result = await addDNSRecord("x.com", "C7", {
      type: "A",
      name: "@",
      value: "1.2.3.4",
      ttl: 7200,
    });
    expect(result.message).toBe("Duplicate record");
  });
});

describe("updateDNSRecord", () => {
  it("POSTs /api/dns/manage/modify-record.json + host @ normalisation", async () => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await updateDNSRecord("x.com", "R1", {
      type: "A",
      name: "@",
      value: "1.2.3.4",
      ttl: 3600,
      priority: 10,
    });
    const [url, , opts] = apiPost.mock.calls[0];
    expect(url).toBe("/api/dns/manage/modify-record.json");
    expect(opts.params["record-id"]).toBe("R1");
    expect(opts.params.host).toBe("x.com");
    expect(opts.params.priority).toBe(10);
  });

  it("non-@ host passes through unchanged", async () => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await updateDNSRecord("x.com", "R1", {
      type: "A",
      name: "www",
      value: "1.2.3.4",
      ttl: 3600,
    });
    expect(apiPost.mock.calls[0][2].params.host).toBe("www");
  });

  it("axios throw → generic 'Failed to update DNS record'", async () => {
    apiPost.mockRejectedValueOnce(new Error("503"));
    const result = await updateDNSRecord("x.com", "R1", {
      type: "A",
      name: "@",
      value: "1.2.3.4",
      ttl: 3600,
    });
    expect(result.message).toBe("Failed to update DNS record");
  });
});

describe("deleteDNSRecord", () => {
  it("POSTs /api/dns/manage/delete-record.json with record-id + echoed host/value/type", async () => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await deleteDNSRecord("x.com", "R1", {
      type: "A",
      name: "www",
      value: "1.2.3.4",
      ttl: 3600,
    });
    const [url, , opts] = apiPost.mock.calls[0];
    expect(url).toBe("/api/dns/manage/delete-record.json");
    expect(opts.params).toMatchObject({
      "domain-name": "x.com",
      "record-id": "R1",
      host: "www",
      value: "1.2.3.4",
      type: "A",
    });
  });
});

describe("setDefaultNameservers", () => {
  it("delegates to setCustomNameservers with the 4 hardcoded RC nameservers", async () => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await setDefaultNameservers("ORD_42");
    const [url, , opts] = apiPost.mock.calls[0];
    expect(url).toBe("/api/domains/modify-ns.json");
    expect(opts.params.ns).toEqual([
      "deepak1299294.mercury.orderbox-dns.com",
      "deepak1299294.venus.orderbox-dns.com",
      "deepak1299294.earth.orderbox-dns.com",
      "deepak1299294.mars.orderbox-dns.com",
    ]);
  });
});

describe("setCustomNameservers", () => {
  it("ns array → repeated ns= params via custom paramsSerializer", async () => {
    apiPost.mockResolvedValueOnce({ data: { ok: true } });
    await setCustomNameservers("ORD_42", ["ns1.x", "ns2.x"]);
    const [, , opts] = apiPost.mock.calls[0];
    // Verify the serializer turns the array into repeated params.
    const serialized = opts.paramsSerializer({
      "order-id": "ORD_42",
      ns: ["ns1.x", "ns2.x"],
    });
    expect(serialized).toContain("ns=ns1.x");
    expect(serialized).toContain("ns=ns2.x");
    expect(serialized).toContain("order-id=ORD_42");
  });
});

describe("getNameservers — 2-step lookup", () => {
  it("orderId lookup fail → returns [] without calling details", async () => {
    getDomainOrderId.mockResolvedValueOnce({ status: "error" });
    expect(await getNameservers("x.com")).toEqual([]);
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("happy path: collects ns1..ns13 dynamically (skip gaps)", async () => {
    getDomainOrderId.mockResolvedValueOnce({
      status: "success",
      data: "ORD_42",
    });
    apiGet.mockResolvedValueOnce({
      data: {
        ns1: "ns1.x",
        ns2: "ns2.x",
        ns5: "ns5.x", // gap — ns3/ns4 missing
      },
    });
    expect(await getNameservers("x.com")).toEqual(["ns1.x", "ns2.x", "ns5.x"]);
  });

  it("details call uses options:NsDetails (required to populate ns fields)", async () => {
    getDomainOrderId.mockResolvedValueOnce({
      status: "success",
      data: "ORD_42",
    });
    apiGet.mockResolvedValueOnce({ data: {} });
    await getNameservers("x.com");
    expect(apiGet).toHaveBeenCalledWith("/api/domains/details.json", {
      params: { "order-id": "ORD_42", options: "NsDetails" },
    });
  });

  it("axios throw → returns [] (never crashes callers)", async () => {
    getDomainOrderId.mockResolvedValueOnce({
      status: "success",
      data: "ORD_42",
    });
    apiGet.mockRejectedValueOnce(new Error("503"));
    expect(await getNameservers("x.com")).toEqual([]);
  });
});
