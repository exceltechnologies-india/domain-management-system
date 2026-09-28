/**
 * GET /api/public/hosting-prices — the panel browser's copy-free price read (owner, 28 Sep 2026).
 * Pinned: ResellerOS's table is passed through; when it cannot be read the answer is 503 with a
 * sentence for the customer and no table at all.
 */
import { describe, it, expect, vi } from "vitest";
import { PRICE_TABLE } from "../../../../../fixtures/hosting-price-table";

const out = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/reselleros/hosting-prices", async (orig) => ({
  ...(await orig<typeof import("@/lib/reselleros/hosting-prices")>()),
  fetchHostingPrices: async () => out.value,
}));
vi.mock("@/lib/server-logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<typeof import("next/server")>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/public/hosting-prices/route";

describe("GET /api/public/hosting-prices", () => {
  it("passes ResellerOS's table through", async () => {
    out.value = { ok: true, table: PRICE_TABLE };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "ok", table: PRICE_TABLE });
  });
  it("unreadable → 503, a sentence, and no table", async () => {
    out.value = { ok: false, detail: "down" };
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.state).toBe("unavailable");
    expect(body.message).toMatch(/couldn't load hosting prices/);
    expect(body).not.toHaveProperty("table");
  });
});
