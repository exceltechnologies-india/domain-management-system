/**
 * Tests for `@/lib/directadmin/dns` (rescan-4 slice 7eu).
 * DA DNS record CRUD (getDNSRecords + deleteDNSRecords + addDNSRecord
 * + the disabled updateDNSNameservers stub). Pins:
 *  - getDNSRecords validates username FIRST + uses
 *    `${ADMIN_USER}|{username}` auth (DA's per-user proxy form)
 *  - **2 response-shape parsers**: numbered-key (`name0/value0/type0/
 *    ttl0/key0`) when DA returns URL-encoded form, BIND zone file
 *    fallback (newer DA versions return raw zone files for `action=view`)
 *  - BIND-fallback: detects $TTL or `IN<tab>NS` / `IN NS` substring;
 *    skips comment ($/;) lines; regex `Name [TTL] IN Type Value`
 *    parses to record shape
 *  - **key construction**: numbered-key parser uses `data[keyN]` when
 *    present, else synthesises `name={name}&value={value}` (needed
 *    for the deletion API which requires the select-value form)
 *  - deleteDNSRecords short-circuits on empty array (no HTTP call)
 *  - deleteDNSRecords payload: `action=select` + `selectN={key OR
 *    synthesised}` per record; Content-Type x-www-form-urlencoded
 *  - addDNSRecord defaults ttl='14400'; **NS-record-at-root special
 *    case**: empty name → `${domain}.` (the trailing dot is required
 *    by DA's zone-file parser for root-level NS records)
 *  - addDNSRecord non-NS empty name → defaults to domain (root)
 *  - All 3 fns throw DirectAdminError on `error=1` response
 *  - updateDNSNameservers ALWAYS throws (intentionally disabled —
 *    DNS authority decided at purchase time)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const executeRequestMock = vi.hoisted(() =>
  vi.fn(async (fn: () => Promise<unknown>) => fn())
);
const validateUsernameMock = vi.hoisted(() => vi.fn());
const parseDAErrorMock = vi.hoisted(() =>
  vi.fn((data: unknown) => {
    if (typeof data === "object" && data && "text" in data) {
      return (data as { text?: string }).text || "DA error";
    }
    return "parsed";
  })
);
const parseResponseDataMock = vi.hoisted(() =>
  vi.fn((data: unknown) => data)
);
const DirectAdminErrorClass = vi.hoisted(
  () =>
    class extends Error {
      context?: string;
      status?: number;
      constructor(
        message: string,
        context?: string,
        status?: number
      ) {
        super(message);
        this.name = "DirectAdminError";
        this.context = context;
        this.status = status;
      }
    }
);

vi.mock("@/lib/directadmin/client", () => ({
  ADMIN_USER: "admin",
  API_KEY: "test-key",
  DA_URL: "https://da.test:2222",
  DEFAULT_TIMEOUT_MS: 8000,
  DirectAdminError: DirectAdminErrorClass,
  executeRequest: executeRequestMock,
  parseDAError: parseDAErrorMock,
  parseResponseData: parseResponseDataMock,
  validateUsername: validateUsernameMock,
}));

const axiosGetMock = vi.hoisted(() => vi.fn());
const axiosPostMock = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({
  default: { get: axiosGetMock, post: axiosPostMock },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  getDNSRecords,
  deleteDNSRecords,
  addDNSRecord,
  updateDNSNameservers,
} from "@/lib/directadmin/dns";

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  executeRequestMock.mockClear();
  validateUsernameMock.mockReset();
  parseResponseDataMock.mockReset();
  parseResponseDataMock.mockImplementation((d: unknown) => d);
});

describe("getDNSRecords", () => {
  it("validates username FIRST — throw bypasses the HTTP call", async () => {
    validateUsernameMock.mockImplementationOnce(() => {
      throw new Error("Bad username");
    });
    await expect(getDNSRecords("bad-user", "x.com")).rejects.toThrow(
      /Bad username/
    );
    expect(axiosGetMock).not.toHaveBeenCalled();
  });

  it("auth uses ADMIN_USER|username form (DA's per-user proxy)", async () => {
    parseResponseDataMock.mockReturnValueOnce({});
    axiosGetMock.mockResolvedValueOnce({ data: "" });
    await getDNSRecords("alice", "x.com");
    expect(axiosGetMock).toHaveBeenCalledWith(
      "https://da.test:2222/CMD_API_DNS_CONTROL",
      expect.objectContaining({
        auth: { username: "admin|alice", password: "test-key" },
        timeout: 8000,
      })
    );
  });

  it("numbered-key parse: records[i] from nameN/valueN/typeN/ttlN/keyN", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      name0: "@",
      value0: "1.2.3.4",
      type0: "A",
      ttl0: "14400",
      key0: "name=@&value=1.2.3.4",
      name1: "www",
      value1: "1.2.3.4",
      type1: "A",
      ttl1: "14400",
      key1: "name=www&value=1.2.3.4",
    });
    axiosGetMock.mockResolvedValueOnce({
      data: "name0=@&value0=1.2.3.4",
    });
    const result = await getDNSRecords("alice", "x.com");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: "@",
      value: "1.2.3.4",
      type: "A",
      ttl: "14400",
      key: "name=@&value=1.2.3.4",
    });
  });

  it("key SYNTHESISED when not present: `name={n}&value={v}`", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      name0: "www",
      value0: "1.2.3.4",
      type0: "A",
      ttl0: "14400",
      // no key0
    });
    axiosGetMock.mockResolvedValueOnce({ data: "name0=www" });
    const result = await getDNSRecords("alice", "x.com");
    expect(result[0].key).toBe("name=www&value=1.2.3.4");
  });

  it("BIND-fallback (raw zone file with $TTL) is parsed via regex", async () => {
    const zoneFile = `; Comment
$TTL 14400
$ORIGIN x.com.

@		3600	IN	SOA	ns1.x.com. admin.x.com. (...)
@		14400	IN	A	1.2.3.4
www		14400	IN	CNAME	@
mail		14400	IN	A	5.6.7.8
`;
    axiosGetMock.mockResolvedValueOnce({ data: zoneFile });
    const result = await getDNSRecords("alice", "x.com");
    // The regex matches `Name [TTL] IN Type Value` — skips ; and $ lines.
    // Multiple records parsed.
    const aRecords = result.filter((r) => r.type === "A");
    expect(aRecords.length).toBeGreaterThanOrEqual(2);
    expect(aRecords[0].name).toBe("@");
    expect(aRecords[0].value).toBe("1.2.3.4");
    const cname = result.find((r) => r.type === "CNAME");
    expect(cname?.name).toBe("www");
  });

  it("BIND-fallback with tab-separated 'IN<tab>NS' also detected", async () => {
    const zoneFile = `@\t14400\tIN\tNS\tns1.x.com.
www\t14400\tIN\tA\t1.2.3.4
`;
    axiosGetMock.mockResolvedValueOnce({ data: zoneFile });
    const result = await getDNSRecords("alice", "x.com");
    expect(result.length).toBeGreaterThan(0);
  });

  it("DA error response → DirectAdminError with 'GetDNSRecords' context", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: { error: "1", text: "Access denied" },
    });
    try {
      await getDNSRecords("alice", "x.com");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DirectAdminErrorClass);
      expect((e as { context?: string }).context).toBe("GetDNSRecords");
    }
  });
});

describe("deleteDNSRecords", () => {
  it("empty records array → short-circuit, NO HTTP call", async () => {
    await deleteDNSRecords("alice", "x.com", []);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("null/undefined records → short-circuit", async () => {
    await deleteDNSRecords("alice", "x.com", null as never);
    await deleteDNSRecords("alice", "x.com", undefined as never);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("POSTs CMD_API_DNS_CONTROL with action=select + selectN per record", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await deleteDNSRecords("alice", "x.com", [
      { name: "@", value: "1.2.3.4", type: "A", key: "name=@&value=1.2.3.4" },
      { name: "www", value: "5.6.7.8", type: "A" },
    ]);
    const [url, body, opts] = axiosPostMock.mock.calls[0];
    expect(url).toBe("https://da.test:2222/CMD_API_DNS_CONTROL");
    const params = new URLSearchParams(body as string);
    expect(params.get("domain")).toBe("x.com");
    expect(params.get("action")).toBe("select");
    expect(params.get("select0")).toBe("name=@&value=1.2.3.4");
    // No `key` on the second record → synthesises name=www&value=5.6.7.8
    expect(params.get("select1")).toBe("name=www&value=5.6.7.8");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(opts.auth.username).toBe("admin|alice");
  });

  it("DA error → DirectAdminError with 'DeleteDNSRecords' context", async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { error: "1", text: "fail" },
    });
    try {
      await deleteDNSRecords("alice", "x.com", [
        { name: "@", value: "1.2.3.4" },
      ]);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DirectAdminErrorClass);
      expect((e as { context?: string }).context).toBe("DeleteDNSRecords");
    }
  });
});

describe("addDNSRecord", () => {
  it("defaults: ttl=14400 + name defaults to domain when empty", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await addDNSRecord("alice", "x.com", "A", "1.2.3.4");
    const [, body] = axiosPostMock.mock.calls[0];
    const params = new URLSearchParams(body as string);
    expect(params.get("domain")).toBe("x.com");
    expect(params.get("action")).toBe("add");
    expect(params.get("type")).toBe("A");
    expect(params.get("value")).toBe("1.2.3.4");
    expect(params.get("name")).toBe("x.com");
    expect(params.get("ttl")).toBe("14400");
  });

  it("explicit name passes through", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await addDNSRecord("alice", "x.com", "A", "1.2.3.4", "www");
    const body = axiosPostMock.mock.calls[0][1] as string;
    expect(new URLSearchParams(body).get("name")).toBe("www");
  });

  it("NS record at root: empty name → adds the trailing dot (`{domain}.`)", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await addDNSRecord("alice", "x.com", "NS", "ns1.x.com.");
    const body = axiosPostMock.mock.calls[0][1] as string;
    expect(new URLSearchParams(body).get("name")).toBe("x.com.");
  });

  it("NS record with explicit name: trailing-dot fix NOT applied", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await addDNSRecord("alice", "x.com", "NS", "ns1.x.com.", "sub");
    expect(new URLSearchParams(axiosPostMock.mock.calls[0][1] as string).get("name")).toBe("sub");
  });

  it("DA error → DirectAdminError with 'AddDNSRecord' context", async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { error: "1", text: "Record exists" },
    });
    try {
      await addDNSRecord("alice", "x.com", "A", "1.2.3.4");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DirectAdminErrorClass);
      expect((e as { context?: string }).context).toBe("AddDNSRecord");
    }
  });
});

describe("updateDNSNameservers (intentionally disabled)", () => {
  it("ALWAYS throws — DNS authority decided at purchase time", async () => {
    await expect(
      updateDNSNameservers("alice", "x.com", ["ns1.x", "ns2.x"])
    ).rejects.toThrow(/Automatic DNS syncing is disabled/);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });
});
