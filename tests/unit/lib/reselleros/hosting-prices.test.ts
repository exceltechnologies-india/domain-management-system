/**
 * lib/reselleros/hosting-prices.ts — ResellerOS's hosting prices read live (owner, 28 Sep 2026).
 *
 * Pinned: no server URL → unavailable, nothing fetched; a good answer is parsed and kept for a
 * minute; a failure (unreachable, non-200, half-read table) is never kept and never replaced
 * by a figure; the cache is per ResellerOS address.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchHostingPrices, resetHostingPricesCache } from "@/lib/reselleros/hosting-prices";
import { PRICE_TABLE } from "../../../fixtures/hosting-price-table";

const ENV = { RESELLEROS_SERVER_URL: "https://ros.example.test/" };
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => resetHostingPricesCache());

describe("fetchHostingPrices", () => {
  it("no RESELLEROS_SERVER_URL → unavailable, nothing fetched", async () => {
    const f = reply(200, PRICE_TABLE);
    expect(await fetchHostingPrices({ env: {}, fetchImpl: f })).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("reads /api/public/hosting-prices and returns ResellerOS's table as it is", async () => {
    const f = reply(200, PRICE_TABLE);
    expect(await fetchHostingPrices({ env: ENV, fetchImpl: f })).toEqual({ ok: true, table: PRICE_TABLE });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://ros.example.test/api/public/hosting-prices");
  });

  it("keeps a good answer for 60 seconds, then asks again", async () => {
    let t = 1_000_000;
    const f = reply(200, PRICE_TABLE);
    await fetchHostingPrices({ env: ENV, fetchImpl: f, now: () => t });
    t += 59_000;
    await fetchHostingPrices({ env: ENV, fetchImpl: f, now: () => t });
    expect(f).toHaveBeenCalledTimes(1);
    t += 2_000;
    await fetchHostingPrices({ env: ENV, fetchImpl: f, now: () => t });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a failure is never cached and never becomes a price", async () => {
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await fetchHostingPrices({ env: ENV, fetchImpl: down })).toMatchObject({ ok: false });
    expect(await fetchHostingPrices({ env: ENV, fetchImpl: reply(500, {}) })).toMatchObject({ ok: false, detail: expect.stringMatching(/500/) });
    const half = { ...PRICE_TABLE, plans: [{ ...PRICE_TABLE.plans[0], yearly: { months: 12, exGst: 600 } }] };
    expect(await fetchHostingPrices({ env: ENV, fetchImpl: reply(200, half) })).toMatchObject({ ok: false, detail: expect.stringMatching(/incomplete/) });
    const good = reply(200, PRICE_TABLE);
    expect((await fetchHostingPrices({ env: ENV, fetchImpl: good })).ok).toBe(true);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("the cache belongs to one ResellerOS address", async () => {
    const f = reply(200, PRICE_TABLE);
    await fetchHostingPrices({ env: ENV, fetchImpl: f });
    await fetchHostingPrices({ env: { RESELLEROS_SERVER_URL: "https://other.example.test" }, fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(2);
  });
});
