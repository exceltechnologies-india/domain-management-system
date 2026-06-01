/**
 * Tests for `@/lib/resellerclub-wrapper` (rescan-4 slice 7eh).
 * The legacy ResellerClubWrapper static facade — pre-dates the
 * `lib/integrations/resellerclub/` typed-outcome layer; routes all
 * calls to ResellerClubAPI verbatim with log lines + a couple of
 * coordinator methods. Pins:
 *  - Every method delegates to ResellerClubAPI.X (no business logic
 *    other than logging) — pinned via referential identity (mocked
 *    target captures the args, wrapper passes them through)
 *  - **registerDomain re-shapes the contacts object** from
 *    `{admin, tech, billing}` to the flat `{adminContactId, techContactId,
 *    billingContactId}` form that ResellerClubAPI.registerDomain expects
 *  - **renewDomain orchestrates 2 lookups before the renew call**:
 *    getDomainOrderId → resolve order-id, getDomainExpiry → resolve
 *    Unix-second expiry, THEN renewDomain(orderId, years, expDate);
 *    early-return on any lookup failure (orderId missing, expiry
 *    missing, or zero expDate)
 *  - renewDomain's expiry resolution accepts BOTH `endtime` field AND
 *    the `expiry-date` alias (RC has used both in different API
 *    revisions); endtime takes precedence when present
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RCAPI = vi.hoisted(() => ({
  searchDomain: vi.fn(),
  searchDomainWithTlds: vi.fn(),
  registerDomain: vi.fn(),
  getDomainDetails: vi.fn(),
  getDomainOrderId: vi.fn(),
  getDomainExpiry: vi.fn(),
  getDNSRecords: vi.fn(),
  renewDomain: vi.fn(),
  transferDomain: vi.fn(),
  addDNSRecord: vi.fn(),
  updateDNSRecord: vi.fn(),
  deleteDNSRecord: vi.fn(),
  setDefaultNameservers: vi.fn(),
  setCustomNameservers: vi.fn(),
  activateDNSManagement: vi.fn(),
  getNameservers: vi.fn(),
  deleteDomainOrder: vi.fn(),
}));
vi.mock("@/lib/resellerclub", () => ({ ResellerClubAPI: RCAPI }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/pricing-service", () => ({ PricingService: {} }));

import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";

beforeEach(() => {
  Object.values(RCAPI).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockReset());
});

describe("simple delegations to ResellerClubAPI", () => {
  it("searchDomain forwards the domain name verbatim", async () => {
    RCAPI.searchDomain.mockResolvedValueOnce([]);
    await ResellerClubWrapper.searchDomain("example");
    expect(RCAPI.searchDomain).toHaveBeenCalledWith("example");
  });

  it("searchDomainWithTlds forwards both args", async () => {
    RCAPI.searchDomainWithTlds.mockResolvedValueOnce([]);
    await ResellerClubWrapper.searchDomainWithTlds("example", ["com", "net"]);
    expect(RCAPI.searchDomainWithTlds).toHaveBeenCalledWith("example", [
      "com",
      "net",
    ]);
  });

  it("getDomainDetails passes the name through", async () => {
    RCAPI.getDomainDetails.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.getDomainDetails("x.com");
    expect(RCAPI.getDomainDetails).toHaveBeenCalledWith("x.com");
  });

  it("getDomainOrderId / getDNSRecords / getNameservers / deleteDomainOrder forward args", async () => {
    RCAPI.getDomainOrderId.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.getDomainOrderId("x.com");
    expect(RCAPI.getDomainOrderId).toHaveBeenCalledWith("x.com");

    RCAPI.getDNSRecords.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.getDNSRecords("x.com", "cust1");
    expect(RCAPI.getDNSRecords).toHaveBeenCalledWith("x.com", "cust1");

    RCAPI.getNameservers.mockResolvedValueOnce([]);
    await ResellerClubWrapper.getNameservers("x.com");
    expect(RCAPI.getNameservers).toHaveBeenCalledWith("x.com");

    RCAPI.deleteDomainOrder.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.deleteDomainOrder("ORD_42");
    expect(RCAPI.deleteDomainOrder).toHaveBeenCalledWith("ORD_42");
  });

  it("setDefaultNameservers / setCustomNameservers / activateDNSManagement forward args", async () => {
    RCAPI.setDefaultNameservers.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.setDefaultNameservers("ORD_1");
    expect(RCAPI.setDefaultNameservers).toHaveBeenCalledWith("ORD_1");

    RCAPI.setCustomNameservers.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.setCustomNameservers("ORD_1", ["ns1.x", "ns2.x"]);
    expect(RCAPI.setCustomNameservers).toHaveBeenCalledWith("ORD_1", [
      "ns1.x",
      "ns2.x",
    ]);

    RCAPI.activateDNSManagement.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.activateDNSManagement("x.com", "ORD_1");
    expect(RCAPI.activateDNSManagement).toHaveBeenCalledWith("x.com", "ORD_1");
  });

  it("transferDomain forwards full {domain, authCode, customerId, contacts}", async () => {
    RCAPI.transferDomain.mockResolvedValueOnce({ status: "success" });
    const contacts = { admin: 1, tech: 2, billing: 3 };
    await ResellerClubWrapper.transferDomain("x.com", "AUTH", 7, contacts);
    expect(RCAPI.transferDomain).toHaveBeenCalledWith("x.com", "AUTH", 7, contacts);
  });

  it("DNS record CRUD forwards {type, name, value, ttl, priority?}", async () => {
    const recordData = {
      type: "A",
      name: "@",
      value: "1.2.3.4",
      ttl: 3600,
      priority: 10,
    };
    RCAPI.addDNSRecord.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.addDNSRecord("x.com", "cust1", recordData);
    expect(RCAPI.addDNSRecord).toHaveBeenCalledWith("x.com", "cust1", recordData);

    RCAPI.updateDNSRecord.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.updateDNSRecord("x.com", "REC_1", recordData);
    expect(RCAPI.updateDNSRecord).toHaveBeenCalledWith("x.com", "REC_1", recordData);

    RCAPI.deleteDNSRecord.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.deleteDNSRecord("x.com", "REC_1", recordData);
    expect(RCAPI.deleteDNSRecord).toHaveBeenCalledWith("x.com", "REC_1", recordData);
  });
});

describe("registerDomain — args reshape", () => {
  it("flattens contacts {admin, tech, billing} → {adminContactId, techContactId, billingContactId}", async () => {
    RCAPI.registerDomain.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.registerDomain(
      "x.com",
      1,
      7,
      ["ns1.x", "ns2.x"],
      { admin: 11, tech: 22, billing: 33 },
      { something: "extra" }
    );
    expect(RCAPI.registerDomain).toHaveBeenCalledWith({
      domainName: "x.com",
      years: 1,
      customerId: 7,
      nameServers: ["ns1.x", "ns2.x"],
      adminContactId: 11,
      techContactId: 22,
      billingContactId: 33,
      tldAttributes: { something: "extra" },
    });
  });

  it("contacts omitted → adminContactId/techContactId/billingContactId all undefined", async () => {
    RCAPI.registerDomain.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.registerDomain("x.com", 2, 7);
    const [args] = RCAPI.registerDomain.mock.calls[0];
    expect(args.adminContactId).toBeUndefined();
    expect(args.techContactId).toBeUndefined();
    expect(args.billingContactId).toBeUndefined();
    expect(args.tldAttributes).toBeUndefined();
  });
});

describe("renewDomain — 2-step lookup orchestration", () => {
  it("happy path: getDomainOrderId → getDomainExpiry → renewDomain(orderId, years, expDate)", async () => {
    RCAPI.getDomainOrderId.mockResolvedValueOnce({
      status: "success",
      data: "ORD_42",
    });
    RCAPI.getDomainExpiry.mockResolvedValueOnce({
      status: "success",
      data: { endtime: "1700000000" },
    });
    RCAPI.renewDomain.mockResolvedValueOnce({ status: "success" });
    const result = await ResellerClubWrapper.renewDomain("x.com", 2);
    expect(result.status).toBe("success");
    expect(RCAPI.renewDomain).toHaveBeenCalledWith("ORD_42", 2, 1700000000);
  });

  it("endtime takes precedence over 'expiry-date' alias when both present", async () => {
    RCAPI.getDomainOrderId.mockResolvedValueOnce({ status: "success", data: "ORD_42" });
    RCAPI.getDomainExpiry.mockResolvedValueOnce({
      status: "success",
      data: { endtime: "1700000000", "expiry-date": "1800000000" },
    });
    RCAPI.renewDomain.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.renewDomain("x.com", 1);
    const [, , expDate] = RCAPI.renewDomain.mock.calls[0];
    expect(expDate).toBe(1700000000);
  });

  it("falls back to 'expiry-date' alias when endtime missing", async () => {
    RCAPI.getDomainOrderId.mockResolvedValueOnce({ status: "success", data: "ORD_42" });
    RCAPI.getDomainExpiry.mockResolvedValueOnce({
      status: "success",
      data: { "expiry-date": "1800000000" },
    });
    RCAPI.renewDomain.mockResolvedValueOnce({ status: "success" });
    await ResellerClubWrapper.renewDomain("x.com", 1);
    const [, , expDate] = RCAPI.renewDomain.mock.calls[0];
    expect(expDate).toBe(1800000000);
  });

  it("orderId lookup fails → early-return error WITHOUT calling expiry / renew", async () => {
    RCAPI.getDomainOrderId.mockResolvedValueOnce({
      status: "error",
      message: "Not found",
    });
    const result = await ResellerClubWrapper.renewDomain("x.com", 1);
    expect(result.status).toBe("error");
    expect(result.message).toContain("Could not resolve");
    expect(RCAPI.getDomainExpiry).not.toHaveBeenCalled();
    expect(RCAPI.renewDomain).not.toHaveBeenCalled();
  });

  it("expiry lookup fails → early-return error WITHOUT calling renew", async () => {
    RCAPI.getDomainOrderId.mockResolvedValueOnce({ status: "success", data: "ORD_42" });
    RCAPI.getDomainExpiry.mockResolvedValueOnce({
      status: "error",
      message: "Cannot fetch",
    });
    const result = await ResellerClubWrapper.renewDomain("x.com", 1);
    expect(result.status).toBe("error");
    expect(result.message).toContain("Could not fetch");
    expect(RCAPI.renewDomain).not.toHaveBeenCalled();
  });

  it("expiry returns 0 / missing → error 'Could not determine expiry date'", async () => {
    RCAPI.getDomainOrderId.mockResolvedValueOnce({ status: "success", data: "ORD_42" });
    RCAPI.getDomainExpiry.mockResolvedValueOnce({
      status: "success",
      data: { endtime: "0" },
    });
    const result = await ResellerClubWrapper.renewDomain("x.com", 1);
    expect(result.status).toBe("error");
    expect(result.message).toContain("Could not determine expiry");
    expect(RCAPI.renewDomain).not.toHaveBeenCalled();
  });
});
