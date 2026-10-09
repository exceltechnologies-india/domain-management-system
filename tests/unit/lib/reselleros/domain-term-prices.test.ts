/**
 * lib/reselleros/domain-term-prices.ts — what ResellerOS charges for a domain per term
 * (9 Oct 2026). Pinned: it asks ResellerOS's own availability lookup for exactly that name; it
 * keeps only the offered terms; a failure is never cached and never replaced by a figure.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cleanTermTotals,
  fetchDomainTermPrices,
  resetDomainTermPricesCache,
  splitDomainName,
} from "@/lib/reselleros/domain-term-prices";

const ENV = { RESELLEROS_SERVER_URL: "https://ros.example.test/" };
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const ROW = {
  domain: "shop.in", available: true, price: 863, currency: "INR", years: 1, priceKnown: true,
  prices: { "1": 863, "2": 1726, "3": 2588, "4": 3451, "5": 4314 },
};

beforeEach(() => resetDomainTermPricesCache());

describe("fetchDomainTermPrices", () => {
  it("asks /api/domains/availability for that one name and returns the offered terms", async () => {
    const f = reply(200, { base: "shop", domains: [ROW], source: "resellerclub" });
    expect(await fetchDomainTermPrices("Shop.IN", { env: ENV, fetchImpl: f })).toEqual({
      ok: true, domain: "shop.in", available: true, totals: { "1": 863, "2": 1726, "3": 2588, "5": 4314 },
    });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://ros.example.test/api/domains/availability?name=shop&tlds=in");
  });

  it("handles a two-part TLD", async () => {
    const f = reply(200, { domains: [{ ...ROW, domain: "shop.co.in" }] });
    expect(await fetchDomainTermPrices("shop.co.in", { env: ENV, fetchImpl: f })).toMatchObject({ ok: true, domain: "shop.co.in" });
    expect((f.mock.calls[0] as unknown as [string])[0]).toContain("name=shop&tlds=co.in");
  });

  it("keeps a good answer for a minute, per domain", async () => {
    const f = reply(200, { domains: [ROW] });
    let t = 0;
    const now = () => t;
    await fetchDomainTermPrices("shop.in", { env: ENV, fetchImpl: f, now });
    t = 59_000;
    await fetchDomainTermPrices("shop.in", { env: ENV, fetchImpl: f, now });
    expect(f).toHaveBeenCalledTimes(1);
    t = 61_000;
    await fetchDomainTermPrices("shop.in", { env: ENV, fetchImpl: f, now });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("no server URL, a bad name, non-200, unreachable, no row or no price → unavailable, never a figure", async () => {
    const f = reply(200, { domains: [ROW] });
    expect(await fetchDomainTermPrices("shop.in", { env: {}, fetchImpl: f })).toMatchObject({ ok: false });
    expect(await fetchDomainTermPrices("not a domain", { env: ENV, fetchImpl: f })).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
    expect(await fetchDomainTermPrices("shop.in", { env: ENV, fetchImpl: reply(502, {}) })).toMatchObject({ ok: false });
    const boom = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect(await fetchDomainTermPrices("shop.in", { env: ENV, fetchImpl: boom as unknown as typeof fetch })).toMatchObject({ ok: false });
    expect(await fetchDomainTermPrices("shop.in", { env: ENV, fetchImpl: reply(200, { domains: [] }) })).toMatchObject({ ok: false });
    expect(
      await fetchDomainTermPrices("shop.in", { env: ENV, fetchImpl: reply(200, { domains: [{ ...ROW, priceKnown: false }] }) }),
    ).toMatchObject({ ok: false });
  });

  it("does not cache a failure", async () => {
    await fetchDomainTermPrices("shop.in", { env: ENV, fetchImpl: reply(502, {}) });
    const ok = reply(200, { domains: [ROW] });
    expect(await fetchDomainTermPrices("shop.in", { env: ENV, fetchImpl: ok })).toMatchObject({ ok: true });
  });
});

describe("helpers", () => {
  it("splitDomainName takes one registrable name only", () => {
    expect(splitDomainName(" Shop.IN ")).toEqual({ name: "shop", tld: "in" });
    expect(splitDomainName("a.b.shop.in")).toBeNull();
    expect(splitDomainName("https://shop.in")).toBeNull();
  });
  it("cleanTermTotals keeps 1/2/3/5 with positive totals, rounded", () => {
    expect(cleanTermTotals({ "1": 862.8, "2": 0, "3": "2588", "4": 3451, "5": -1 })).toEqual({ "1": 863, "3": 2588 });
    expect(cleanTermTotals(null)).toEqual({});
  });
});
