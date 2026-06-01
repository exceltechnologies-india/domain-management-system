/**
 * Tests for `@/lib/resellerclub/renewal-transfer` (rescan-4 slice 7dz).
 * RC renewal/transfer wire calls. Pins:
 *  - getRenewalPricing: GET /api/domains/renewal-price.json?domain-name&years
 *  - renewDomain: POST /api/domains/renew.json (null body) +
 *    invoice-option=NoInvoice + exp-date stamped through unmodified
 *  - renewDomain error: prefers err.response.data.message > raw .data >
 *    err.message > 'Failed to renew domain'; JSON-stringifies non-string
 *  - transferDomain: contacts optional — when present, fans out to all
 *    4 contact-id fields including reg-contact-id mirroring admin
 *  - All 3 wrap RC errors into {status:'error', message} sentinel
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub/client", () => ({
  api: { get: apiGet, post: apiPost },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  getRenewalPricing,
  renewDomain,
  transferDomain,
} from "@/lib/resellerclub/renewal-transfer";

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("getRenewalPricing", () => {
  it("GETs /api/domains/renewal-price.json with domain-name + years", async () => {
    apiGet.mockResolvedValueOnce({ data: { "1": "10.0" } });
    const result = await getRenewalPricing("example.com", 2);
    expect(apiGet).toHaveBeenCalledWith("/api/domains/renewal-price.json", {
      params: { "domain-name": "example.com", years: 2 },
    });
    expect(result).toEqual({ status: "success", data: { "1": "10.0" } });
  });

  it("wraps RC throws into {status:'error', message}", async () => {
    apiGet.mockRejectedValueOnce(new Error("503"));
    const result = await getRenewalPricing("x.com", 1);
    expect(result).toEqual({
      status: "error",
      message: "Failed to get renewal pricing",
    });
  });
});

describe("renewDomain", () => {
  it("POSTs /api/domains/renew.json with order-id + years + exp-date + NoInvoice", async () => {
    apiPost.mockResolvedValueOnce({ data: { entityid: 999 } });
    const result = await renewDomain("ord_42", 1, 1700000000);
    expect(apiPost).toHaveBeenCalledWith("/api/domains/renew.json", null, {
      params: {
        "order-id": "ord_42",
        years: 1,
        "exp-date": 1700000000,
        "invoice-option": "NoInvoice",
      },
    });
    expect(result).toEqual({ status: "success", data: { entityid: 999 } });
  });

  it("error message: prefers err.response.data.message > raw .data > err.message", async () => {
    // .data is an object with .message
    apiPost.mockRejectedValueOnce({
      response: { data: { message: "Domain is locked" } },
      message: "Request failed",
    });
    const r1 = await renewDomain("ord", 1, 0);
    expect(r1).toEqual({ status: "error", message: "Domain is locked" });

    // .data is a raw string
    apiPost.mockRejectedValueOnce({
      response: { data: "Auth code invalid" },
      message: "Request failed",
    });
    const r2 = await renewDomain("ord", 1, 0);
    expect(r2).toEqual({ status: "error", message: "Auth code invalid" });

    // No response → falls through to err.message
    apiPost.mockRejectedValueOnce({ message: "Network down" });
    const r3 = await renewDomain("ord", 1, 0);
    expect(r3).toEqual({ status: "error", message: "Network down" });

    // No useful info at all → final fallback string
    apiPost.mockRejectedValueOnce({});
    const r4 = await renewDomain("ord", 1, 0);
    expect(r4).toEqual({ status: "error", message: "Failed to renew domain" });
  });
});

describe("transferDomain", () => {
  it("base call: domain-name + auth-code + customer-id + NoInvoice (no contacts)", async () => {
    apiPost.mockResolvedValueOnce({ data: { entityid: 1 } });
    const result = await transferDomain("x.com", "AUTH_CODE_42", 7);
    const [url, body, opts] = apiPost.mock.calls[0];
    expect(url).toBe("/api/domains/transfer.json");
    expect(body).toBeNull();
    expect(opts.params).toEqual({
      "domain-name": "x.com",
      "auth-code": "AUTH_CODE_42",
      "customer-id": 7,
      "invoice-option": "NoInvoice",
    });
    expect(result).toEqual({ status: "success", data: { entityid: 1 } });
  });

  it("with contacts: fans out to all 4 contact fields — reg-contact-id mirrors admin", async () => {
    apiPost.mockResolvedValueOnce({ data: { entityid: 2 } });
    await transferDomain("x.com", "AUTH", 7, { admin: 11, tech: 22, billing: 33 });
    const [, , opts] = apiPost.mock.calls[0];
    expect(opts.params["reg-contact-id"]).toBe(11);
    expect(opts.params["admin-contact-id"]).toBe(11);
    expect(opts.params["tech-contact-id"]).toBe(22);
    expect(opts.params["billing-contact-id"]).toBe(33);
  });

  it("wraps RC throws into {status:'error', message}", async () => {
    apiPost.mockRejectedValueOnce(new Error("503"));
    const result = await transferDomain("x.com", "auth", 7);
    expect(result).toEqual({
      status: "error",
      message: "Failed to transfer domain",
    });
  });
});
