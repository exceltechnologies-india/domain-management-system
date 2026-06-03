/**
 * Tests for `@/lib/zoho-invoice-retry` (rescan-4 slice 7fq).
 * Fire-and-forget retry for orders that paid but didn't get a Zoho
 * invoice. Pins:
 *  - **5-minute Redis throttle** (THROTTLE_SECONDS = 300) keyed by
 *    `zoho-retry:${orderId}` — prevents tight-loop hammering of Zoho
 *    when the user reloads the invoices page repeatedly. Throttle-hit
 *    short-circuits BEFORE the claim attempt (no DB touch).
 *  - **Atomic claim with relaxed gate** {allowNull:true, allowFailed:
 *    true} — terminal `creation_failed` orders DO get re-attempted (a
 *    Zoho outage shouldn't permanently quarantine the order).
 *  - **Claim returns null → skipped:'already_done'** (concurrent caller
 *    or a paid invoice already attached — no double-create).
 *  - **User-not-found → mark failed + return no_user** (the order
 *    points to a vanished user; permanent fail so it stops surfacing
 *    in the stuck list).
 *  - **items projection defaults**: itemType default 'domain', period
 *    default 1, periodUnit default 'years' for non-hosting / 'months'
 *    for hosting (matches what the cart writer stamps at checkout).
 *  - **createInvoice signature**: (orderMeta, user, items, 'Razorpay',
 *    isPaid=true) — the trailing `true` is the paid-flag invariant that
 *    pre-pays the invoice in Zoho so it doesn't go to the customer as
 *    a draft.
 *  - **Successful invoice → recordZohoInvoiceForOrder**; missing
 *    invoice_id → markFailed.
 *  - **AxiosError-shaped throw**: `err.response.data.message` extracted
 *    preferentially; falls back to `err.message`; final fallback
 *    `String(err)`. The catch-path mark-failed is wrapped in a
 *    `.catch(() => {})` so an outer markFailed throw can't crash the
 *    retry loop.
 *  - **selfHealUserInvoices**: empty stuck list → []; outer catch
 *    returns [] (never throws — fire-and-forget contract).
 *  - **syncUserInvoicesNow**: bypasses throttle via {skipThrottle:true};
 *    does NOT have the outer catch — caller-initiated, errors surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const redisCache = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@/lib/redis", () => ({ redisCache }));

const serverLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/server-logger", () => ({ serverLogger }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const createInvoice = vi.hoisted(() => vi.fn());
const ZohoBooksService = vi.hoisted(() => ({
  getInstance: vi.fn(() => ({ createInvoice })),
}));
vi.mock("@/lib/zohobooks", () => ({ ZohoBooksService }));

const claimOrderForZohoInvoice = vi.hoisted(() => vi.fn());
const listStuckZohoInvoiceOrders = vi.hoisted(() => vi.fn());
const markZohoInvoiceCreationFailed = vi.hoisted(() => vi.fn());
const recordZohoInvoiceForOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  claimOrderForZohoInvoice,
  listStuckZohoInvoiceOrders,
  markZohoInvoiceCreationFailed,
  recordZohoInvoiceForOrder,
}));

vi.mock("@/models/User", () => ({ default: {} }));

import { selfHealUserInvoices, syncUserInvoicesNow } from "@/lib/zoho-invoice-retry";

function makeOrder(overrides: Partial<any> = {}): any {
  return {
    _id: { toString: () => "ORDER_OID_1" },
    orderId: "ORD-1",
    userId: "U1",
    amount: 999,
    razorpayPaymentId: "rzpid",
    paymentId: "pid",
    domains: [{ domainName: "x.com", price: 999 }],
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of [
    redisCache.get,
    redisCache.set,
    serverLogger.info,
    serverLogger.warn,
    serverLogger.error,
    getUserById,
    createInvoice,
    ZohoBooksService.getInstance,
    claimOrderForZohoInvoice,
    listStuckZohoInvoiceOrders,
    markZohoInvoiceCreationFailed,
    recordZohoInvoiceForOrder,
  ]) {
    (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  ZohoBooksService.getInstance.mockReturnValue({ createInvoice });
  // Default resolved values so source-side `.catch()` on the return
  // value doesn't blow up on `undefined.catch is not a function`.
  markZohoInvoiceCreationFailed.mockResolvedValue(undefined);
  recordZohoInvoiceForOrder.mockResolvedValue(undefined);
  redisCache.set.mockResolvedValue(undefined);
});

describe("selfHealUserInvoices — throttle gate", () => {
  it("redisCache returns truthy → skipped:'throttled' (NO claim attempt)", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(123456789); // recent timestamp

    const r = await selfHealUserInvoices("U1");

    expect(r).toEqual([
      { ok: false, orderId: "ORD-1", skipped: "throttled" },
    ]);
    expect(claimOrderForZohoInvoice).not.toHaveBeenCalled();
    expect(redisCache.set).not.toHaveBeenCalled();
  });

  it("no recent throttle → sets throttle key with 300s TTL", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce(null); // bail-out to keep test focused

    await selfHealUserInvoices("U1");

    expect(redisCache.set).toHaveBeenCalledWith(
      "zoho-retry:ORDER_OID_1",
      expect.any(Number),
      300
    );
  });
});

describe("selfHealUserInvoices — claim gate", () => {
  it("claim called with {allowNull:true, allowFailed:true} (terminal-failure retry)", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce(null);

    await selfHealUserInvoices("U1");

    expect(claimOrderForZohoInvoice).toHaveBeenCalledWith(
      { toString: expect.any(Function) },
      { allowNull: true, allowFailed: true }
    );
  });

  it("claim returns null → skipped:'already_done' (no user lookup, no Zoho call)", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce(null);

    const r = await selfHealUserInvoices("U1");

    expect(r[0]).toEqual({
      ok: false,
      orderId: "ORD-1",
      skipped: "already_done",
    });
    expect(getUserById).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
  });
});

describe("selfHealUserInvoices — user lookup", () => {
  beforeEach(() => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "ORDER_OID_1" });
  });

  it("user not found → markFailed + return no_user", async () => {
    getUserById.mockResolvedValueOnce(null);

    const r = await selfHealUserInvoices("U1");

    expect(r[0]).toEqual({
      ok: false,
      orderId: "ORD-1",
      skipped: "no_user",
      error: "User not found",
    });
    expect(markZohoInvoiceCreationFailed).toHaveBeenCalledWith({
      toString: expect.any(Function),
    });
    expect(createInvoice).not.toHaveBeenCalled();
  });
});

describe("selfHealUserInvoices — invoice creation success", () => {
  it("createInvoice called with (orderMeta, user, items, 'Razorpay', true)", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "ORDER_OID_1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "u@x.com" });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "INV-1",
      invoice_number: "INV-001",
    });

    await selfHealUserInvoices("U1");

    expect(createInvoice).toHaveBeenCalledWith(
      {
        orderId: "ORD-1",
        razorpayPaymentId: "rzpid",
        total: 999,
      },
      { _id: "U1", email: "u@x.com" },
      expect.any(Array),
      "Razorpay",
      true // **paid-flag invariant**
    );
  });

  it("razorpayPaymentId fallback to paymentId; missing both → ''", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([
      makeOrder({ razorpayPaymentId: undefined, paymentId: undefined }),
    ]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({});
    getUserById.mockResolvedValueOnce({});
    createInvoice.mockResolvedValueOnce({ invoice_id: "INV-1" });

    await selfHealUserInvoices("U1");

    expect(createInvoice.mock.calls[0][0].razorpayPaymentId).toBe("");
  });

  it("items projection: defaults itemType=domain, period=1, periodUnit=years (non-hosting)", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([
      makeOrder({
        domains: [{ domainName: "x.com", price: 999 }],
      }),
    ]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({});
    getUserById.mockResolvedValueOnce({});
    createInvoice.mockResolvedValueOnce({ invoice_id: "INV-1" });

    await selfHealUserInvoices("U1");

    const items = createInvoice.mock.calls[0][2];
    expect(items[0]).toMatchObject({
      itemType: "domain",
      domainName: "x.com",
      price: 999,
      registrationPeriod: 1,
      periodUnit: "years",
    });
  });

  it("items projection: hosting itemType → periodUnit defaults to 'months'", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([
      makeOrder({
        domains: [
          { itemType: "hosting", domainName: "h.x.com", price: 1500 },
        ],
      }),
    ]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({});
    getUserById.mockResolvedValueOnce({});
    createInvoice.mockResolvedValueOnce({ invoice_id: "INV-1" });

    await selfHealUserInvoices("U1");

    const items = createInvoice.mock.calls[0][2];
    expect(items[0].periodUnit).toBe("months");
  });

  it("invoice success → recordZohoInvoiceForOrder + ok:true", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({});
    getUserById.mockResolvedValueOnce({});
    createInvoice.mockResolvedValueOnce({
      invoice_id: "INV-1",
      invoice_number: "INV-001",
    });

    const r = await selfHealUserInvoices("U1");

    expect(recordZohoInvoiceForOrder).toHaveBeenCalledWith(
      { toString: expect.any(Function) },
      { invoiceId: "INV-1", invoiceNumber: "INV-001" }
    );
    expect(r[0]).toEqual({
      ok: true,
      orderId: "ORD-1",
      invoiceId: "INV-1",
      invoiceNumber: "INV-001",
    });
  });
});

describe("selfHealUserInvoices — invoice creation failure paths", () => {
  it("invoice missing invoice_id → markFailed + error result", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({});
    getUserById.mockResolvedValueOnce({});
    createInvoice.mockResolvedValueOnce({}); // no invoice_id

    const r = await selfHealUserInvoices("U1");

    expect(markZohoInvoiceCreationFailed).toHaveBeenCalled();
    expect(r[0].ok).toBe(false);
    expect(r[0].error).toMatch(/no invoice_id/);
  });

  it("createInvoice throws — AxiosError.response.data.message extracted preferentially", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({});
    getUserById.mockResolvedValueOnce({});
    createInvoice.mockRejectedValueOnce({
      response: { data: { message: "Zoho rate-limited" } },
      message: "Request failed with status 429",
    });

    const r = await selfHealUserInvoices("U1");

    expect(r[0].error).toBe("Zoho rate-limited");
  });

  it("createInvoice throws — falls back to err.message when no response.data", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({});
    getUserById.mockResolvedValueOnce({});
    createInvoice.mockRejectedValueOnce(new Error("ECONNRESET"));

    const r = await selfHealUserInvoices("U1");

    expect(r[0].error).toBe("ECONNRESET");
  });

  it("createInvoice throws non-Error primitive → String(err) fallback", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({});
    getUserById.mockResolvedValueOnce({});
    createInvoice.mockRejectedValueOnce("string-thrown");

    const r = await selfHealUserInvoices("U1");

    expect(r[0].error).toBe("string-thrown");
  });

  it("markFailed throw on catch path is SWALLOWED (no crash) — fire-and-forget invariant", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    redisCache.get.mockResolvedValueOnce(null);
    claimOrderForZohoInvoice.mockResolvedValueOnce({});
    getUserById.mockResolvedValueOnce({});
    createInvoice.mockRejectedValueOnce(new Error("Zoho down"));
    markZohoInvoiceCreationFailed.mockRejectedValueOnce(new Error("DB down"));

    const r = await selfHealUserInvoices("U1");

    expect(r[0].error).toBe("Zoho down");
    expect(r[0].ok).toBe(false);
  });
});

describe("selfHealUserInvoices — orchestration", () => {
  it("empty stuck list → [] (no logging, no claim)", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([]);

    const r = await selfHealUserInvoices("U1");

    expect(r).toEqual([]);
    expect(serverLogger.info).not.toHaveBeenCalled();
    expect(claimOrderForZohoInvoice).not.toHaveBeenCalled();
  });

  it("outer catch — listStuck throw returns [] (fire-and-forget invariant)", async () => {
    listStuckZohoInvoiceOrders.mockRejectedValueOnce(new Error("DB outage"));

    const r = await selfHealUserInvoices("U1");

    expect(r).toEqual([]);
    expect(serverLogger.error).toHaveBeenCalled();
  });

  it("processes orders sequentially (NOT parallel — keeps Zoho load predictable)", async () => {
    const orderA = makeOrder({ orderId: "ORD-A", _id: { toString: () => "A_OID" } });
    const orderB = makeOrder({ orderId: "ORD-B", _id: { toString: () => "B_OID" } });
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([orderA, orderB]);
    redisCache.get.mockResolvedValue(null);
    claimOrderForZohoInvoice.mockResolvedValue(null);

    const r = await selfHealUserInvoices("U1");

    expect(r).toHaveLength(2);
    expect(r[0].orderId).toBe("ORD-A");
    expect(r[1].orderId).toBe("ORD-B");
  });
});

describe("syncUserInvoicesNow — bypasses throttle", () => {
  it("does NOT call redisCache.get / .set (skipThrottle:true)", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    claimOrderForZohoInvoice.mockResolvedValueOnce(null);

    await syncUserInvoicesNow("U1");

    expect(redisCache.get).not.toHaveBeenCalled();
    expect(redisCache.set).not.toHaveBeenCalled();
  });

  it("still goes through claim gate", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([makeOrder()]);
    claimOrderForZohoInvoice.mockResolvedValueOnce(null);

    const r = await syncUserInvoicesNow("U1");

    expect(r[0].skipped).toBe("already_done");
    expect(claimOrderForZohoInvoice).toHaveBeenCalled();
  });

  it("empty stuck → [] (no logging)", async () => {
    listStuckZohoInvoiceOrders.mockResolvedValueOnce([]);

    const r = await syncUserInvoicesNow("U1");

    expect(r).toEqual([]);
    expect(serverLogger.info).not.toHaveBeenCalled();
  });

  it("does NOT have outer catch — caller-initiated errors surface", async () => {
    listStuckZohoInvoiceOrders.mockRejectedValueOnce(new Error("DB outage"));

    await expect(syncUserInvoicesNow("U1")).rejects.toThrow("DB outage");
  });
});
