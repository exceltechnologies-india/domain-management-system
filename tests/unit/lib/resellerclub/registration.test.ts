/**
 * Tests for `@/lib/resellerclub/registration` (rescan-4 slice 7er).
 * RC domain lifecycle wire wrappers (registerDomain + getDomainDetails
 * + getDomainExpiry + getDomainOrderId + deleteDomainOrder). Pins:
 *  - registerDomain DEFAULTS to the 4 hardcoded `deepak1299294.*.orderbox-dns.com`
 *    nameservers when caller doesn't supply ns; caller-supplied list wins
 *  - registerDomain URLSearchParams shape: domain-name/years/customer-id
 *    + 3 contact-id fields + reg-contact-id mirrors admin-contact-id
 *    (RC requires registrant=admin); 'invoice-option':'NoInvoice';
 *    nameservers appended as repeated `ns=...` params
 *  - registerDomain TLD-policy params appended via getRegistrationParamPairs
 *    (T&C + ccTLD attributes get fanned into the wire)
 *  - response.data.status='error' OR response.data.error → returns
 *    `{status, message, data}` with status 'pending' when message
 *    matches BALANCE_PENDING/PROCESSING_LOCK/ALREADY_IN_PROGRESS or
 *    RC's `InvoicePaid` sentinel; else 'error'
 *  - **friendly message from mapRegistrationError preferred when present**
 *    (registry-policy errors get a clearer caller-facing string)
 *  - AxiosError status mapping: 401→auth, 403→forbidden, 400→invalid,
 *    409→conflict, 429→rate-limit, 5xx→server error, ECONNABORTED→timeout,
 *    ENOTFOUND/ECONNREFUSED→connection failed
 *  - deleteDomainOrder: POSTs `/api/domains/delete.json` with
 *    `order-id`; response.data.status:'error' → wrapped as error
 *  - getDomainDetails + getDomainExpiry both GET `/api/domains/details.json`
 *    (Identical endpoint; distinct callers for clarity); error wrap sentinels
 *  - getDomainOrderId GETs `/api/domains/orderid.json`
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

const getRegistrationParamPairs = vi.hoisted(
  () => vi.fn() as ReturnType<typeof vi.fn>
);
const mapRegistrationError = vi.hoisted(
  () => vi.fn() as ReturnType<typeof vi.fn>
);
vi.mock("@/lib/tld-policies", () => ({
  getRegistrationParamPairs,
  mapRegistrationError,
}));

import {
  registerDomain,
  deleteDomainOrder,
  getDomainDetails,
  getDomainExpiry,
  getDomainOrderId,
} from "@/lib/resellerclub/registration";

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  getRegistrationParamPairs.mockReset();
  getRegistrationParamPairs.mockReturnValue([] as Array<[string, string]>);
  mapRegistrationError.mockReset();
  mapRegistrationError.mockReturnValue(null as string | null);
});

function makeAxiosError(opts: {
  status?: number;
  code?: string;
  data?: unknown;
}): AxiosError {
  const err = new AxiosError("Request failed", opts.code ?? "ERR_BAD_REQUEST");
  if (opts.status !== undefined) {
    err.response = {
      status: opts.status,
      statusText: "",
      headers: {},
      config: {} as never,
      data: opts.data ?? {},
    };
  }
  return err;
}

describe("registerDomain — happy path + nameserver defaulting", () => {
  it("defaults to the 4 hardcoded RC nameservers when caller doesn't supply ns", async () => {
    apiPost.mockResolvedValueOnce({
      data: { entityid: "OK", actionstatus: "Success" },
      status: 200,
    });
    await registerDomain({
      domainName: "x.com",
      years: 1,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
    });
    const [url, params] = apiPost.mock.calls[0];
    expect(url).toBe("/api/domains/register.json");
    const nsValues = (params as URLSearchParams).getAll("ns");
    expect(nsValues).toEqual([
      "deepak1299294.mercury.orderbox-dns.com",
      "deepak1299294.venus.orderbox-dns.com",
      "deepak1299294.earth.orderbox-dns.com",
      "deepak1299294.mars.orderbox-dns.com",
    ]);
  });

  it("custom nameservers wins over the default list", async () => {
    apiPost.mockResolvedValueOnce({ data: { entityid: "OK" }, status: 200 });
    await registerDomain({
      domainName: "x.com",
      years: 1,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
      nameServers: ["ns1.custom.test", "ns2.custom.test"],
    });
    const [, params] = apiPost.mock.calls[0];
    expect((params as URLSearchParams).getAll("ns")).toEqual([
      "ns1.custom.test",
      "ns2.custom.test",
    ]);
  });

  it("wire shape: reg-contact-id MIRRORS admin-contact-id + invoice-option=NoInvoice + period stringified", async () => {
    apiPost.mockResolvedValueOnce({ data: { entityid: "OK" }, status: 200 });
    await registerDomain({
      domainName: "x.com",
      years: 2,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
    });
    const [, params] = apiPost.mock.calls[0];
    const p = params as URLSearchParams;
    expect(p.get("domain-name")).toBe("x.com");
    expect(p.get("years")).toBe("2");
    expect(p.get("customer-id")).toBe("7");
    expect(p.get("reg-contact-id")).toBe("11");
    expect(p.get("admin-contact-id")).toBe("11");
    expect(p.get("tech-contact-id")).toBe("22");
    expect(p.get("billing-contact-id")).toBe("33");
    expect(p.get("invoice-option")).toBe("NoInvoice");
  });

  it("TLD-policy params get appended via getRegistrationParamPairs", async () => {
    getRegistrationParamPairs.mockReturnValue([
      ["us-nexus", "C11"],
      ["tld-tnc-accept", "true"],
    ]);
    apiPost.mockResolvedValueOnce({ data: { entityid: "OK" }, status: 200 });
    await registerDomain({
      domainName: "x.us",
      years: 1,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
      tldAttributes: { someThing: "value" },
    });
    expect(getRegistrationParamPairs).toHaveBeenCalledWith("x.us", {
      someThing: "value",
    });
    const [, params] = apiPost.mock.calls[0];
    expect((params as URLSearchParams).get("us-nexus")).toBe("C11");
    expect((params as URLSearchParams).get("tld-tnc-accept")).toBe("true");
  });

  it("success path → returns {status:'success', data}", async () => {
    apiPost.mockResolvedValueOnce({
      data: { entityid: "12345" },
      status: 200,
    });
    const result = await registerDomain({
      domainName: "x.com",
      years: 1,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
    });
    expect(result).toEqual({ status: "success", data: { entityid: "12345" } });
  });
});

describe("registerDomain — RC error status mapping", () => {
  it("response.data.status:'error' + balance fragment → status:'pending'", async () => {
    apiPost.mockResolvedValueOnce({
      data: { error: "Insufficient balance in account", status: "error" },
      status: 200,
    });
    const result = await registerDomain({
      domainName: "x.com",
      years: 1,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
    });
    expect(result.status).toBe("pending");
  });

  it("response.data.status='InvoicePaid' → status:'pending' (RC's webhook-friendly sentinel)", async () => {
    apiPost.mockResolvedValueOnce({
      data: { status: "InvoicePaid", error: "Order awaiting reconciliation" },
      status: 200,
    });
    const result = await registerDomain({
      domainName: "x.com",
      years: 1,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
    });
    expect(result.status).toBe("pending");
  });

  it("response.data.status:'error' + non-pending message → status:'error'", async () => {
    apiPost.mockResolvedValueOnce({
      data: { status: "error", error: "Invalid TLD attribute" },
      status: 200,
    });
    const result = await registerDomain({
      domainName: "x.com",
      years: 1,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
    });
    expect(result.status).toBe("error");
    expect(result.message).toBe("Invalid TLD attribute");
  });

  it("friendly message from mapRegistrationError preferred over raw error", async () => {
    mapRegistrationError.mockReturnValueOnce(
      "Please accept the .info TLD terms during checkout"
    );
    apiPost.mockResolvedValueOnce({
      data: { status: "error", error: "TLD-PolicyError: TC-NOT-ACCEPTED" },
      status: 200,
    });
    const result = await registerDomain({
      domainName: "x.info",
      years: 1,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
    });
    expect(result.message).toBe(
      "Please accept the .info TLD terms during checkout"
    );
  });
});

describe("registerDomain — AxiosError HTTP-status mapping", () => {
  const cases: Array<{ status?: number; code?: string; expect: RegExp }> = [
    { status: 401, expect: /authentication failed/i },
    { status: 403, expect: /forbidden/i },
    { status: 400, expect: /Invalid domain registration request/i },
    { status: 409, expect: /already be registered/i },
    { status: 429, expect: /rate limit/i },
    { status: 500, expect: /server error/i },
    { code: "ECONNABORTED", expect: /timeout/i },
    { code: "ENOTFOUND", expect: /connection failed/i },
    { code: "ECONNREFUSED", expect: /connection failed/i },
  ];

  it.each(cases)("status=$status code=$code → message $expect", async (c) => {
    apiPost.mockRejectedValueOnce(
      makeAxiosError({ status: c.status, code: c.code })
    );
    const result = await registerDomain({
      domainName: "x.com",
      years: 1,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
    });
    expect(result.status).toBe("error");
    expect(result.message).toMatch(c.expect);
  });

  it("unrecognised AxiosError → generic 'Failed to register domain'", async () => {
    apiPost.mockRejectedValueOnce(makeAxiosError({ status: 418 }));
    const result = await registerDomain({
      domainName: "x.com",
      years: 1,
      customerId: 7,
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
    });
    expect(result.message).toBe("Failed to register domain");
  });
});

describe("deleteDomainOrder", () => {
  it("POSTs /api/domains/delete.json with order-id", async () => {
    apiPost.mockResolvedValueOnce({
      data: { status: "Success", message: "deleted" },
    });
    const result = await deleteDomainOrder("ORD_42");
    expect(apiPost).toHaveBeenCalledWith("/api/domains/delete.json", null, {
      params: { "order-id": "ORD_42" },
    });
    expect(result.status).toBe("success");
  });

  it("response.data.status === 'error' (case-insensitive) → returns error sentinel", async () => {
    apiPost.mockResolvedValueOnce({
      data: { status: "ERROR", message: "Order locked for processing" },
    });
    const result = await deleteDomainOrder("ORD_42");
    expect(result.status).toBe("error");
    expect(result.message).toBe("Order locked for processing");
  });

  it("axios throw → error sentinel with error.message", async () => {
    apiPost.mockRejectedValueOnce(new Error("network down"));
    const result = await deleteDomainOrder("ORD_42");
    expect(result.status).toBe("error");
    expect(result.message).toBe("network down");
  });
});

describe("getDomainDetails / getDomainExpiry / getDomainOrderId", () => {
  it("getDomainDetails GETs /api/domains/details.json with domain-name", async () => {
    apiGet.mockResolvedValueOnce({ data: { endtime: "1700000000" } });
    const result = await getDomainDetails("x.com");
    expect(apiGet).toHaveBeenCalledWith("/api/domains/details.json", {
      params: { "domain-name": "x.com" },
    });
    expect(result.status).toBe("success");
    expect(result.data).toEqual({ endtime: "1700000000" });
  });

  it("getDomainExpiry hits the SAME endpoint (distinct alias for caller clarity)", async () => {
    apiGet.mockResolvedValueOnce({ data: { endtime: "1700000000" } });
    await getDomainExpiry("x.com");
    expect(apiGet).toHaveBeenCalledWith("/api/domains/details.json", {
      params: { "domain-name": "x.com" },
    });
  });

  it("getDomainOrderId GETs /api/domains/orderid.json (separate endpoint)", async () => {
    apiGet.mockResolvedValueOnce({ data: "ORD_42" });
    await getDomainOrderId("x.com");
    expect(apiGet).toHaveBeenCalledWith("/api/domains/orderid.json", {
      params: { "domain-name": "x.com" },
    });
  });

  it("each: error wrapped into its own error-message sentinel", async () => {
    apiGet.mockRejectedValueOnce(new Error("503"));
    expect((await getDomainDetails("x.com")).message).toBe("Failed to get domain details");

    apiGet.mockRejectedValueOnce(new Error("503"));
    expect((await getDomainExpiry("x.com")).message).toBe("Failed to get domain expiry");

    apiGet.mockRejectedValueOnce(new Error("503"));
    expect((await getDomainOrderId("x.com")).message).toBe("Failed to fetch domain order ID");
  });
});
