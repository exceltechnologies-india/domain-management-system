/**
 * lib/reselleros/panel-order.ts — the call that asks ResellerOS for an
 * in-panel purchase's Razorpay order (owner decision 30, 25 Sep 2026).
 *
 * Pinned:
 *  - unset / unusable config refuses before any request is made;
 *  - the request carries the panel key and no price;
 *  - each ResellerOS answer lands in the class of WHO CAN FIX IT;
 *  - a timeout says the order MAY exist; a refused connection says it does not;
 *  - nothing is ever retried (one fetch per call, whatever the outcome).
 */
// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import {
  createPanelOrder,
  panelOrderRefusalMessage,
  readPanelOrderConfig,
  type PanelOrderRequest,
} from "@/lib/reselleros/panel-order";

const ENV = { RESELLEROS_SERVER_URL: "https://ros.example.test/", DMS_PANEL_API_KEY: "k".repeat(24) };

const REQ: PanelOrderRequest = {
  dmsUserId: "abc123",
  fullName: "Asha Rao",
  companyName: "Rao Traders",
  email: "asha@example.test",
  phone: "9876543210",
  domain: "rao.in",
  lines: [{ sku: "hosting:starter", qty: 1, cycle: "yearly" }],
};

function reply(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const OK_BODY = {
  success: true,
  orderId: "order_X",
  amount: 70800,
  currency: "INR",
  razorpayKeyId: "rzp_test_abc",
  razorpayMode: "test",
  quoteId: "Q-1",
  leadId: "L-1",
  customerName: "Asha Rao",
  totalRupees: 708,
};

describe("readPanelOrderConfig", () => {
  it("names every missing setting", () => {
    expect(readPanelOrderConfig({})).toEqual({ ok: false, missing: ["RESELLEROS_SERVER_URL", "DMS_PANEL_API_KEY"] });
  });
  it("refuses a bare host and a key shorter than ResellerOS's 16-char minimum", () => {
    const r = readPanelOrderConfig({ RESELLEROS_SERVER_URL: "ros.example.test", DMS_PANEL_API_KEY: "short" });
    expect(r).toEqual({ ok: false, missing: ["RESELLEROS_SERVER_URL", "DMS_PANEL_API_KEY"] });
  });
  it("strips a trailing slash", () => {
    const r = readPanelOrderConfig(ENV);
    expect(r.ok && r.config.baseUrl).toBe("https://ros.example.test");
  });
});

describe("createPanelOrder", () => {
  it("not configured: refuses without making any request", async () => {
    const fetchImpl = vi.fn();
    const out = await createPanelOrder(REQ, { env: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.kind).toBe("not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the panel key, the exact body, and no price", async () => {
    const fetchImpl = reply(200, OK_BODY);
    await createPanelOrder(REQ, { env: ENV, fetchImpl });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ros.example.test/api/dms/panel-order");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ENV.DMS_PANEL_API_KEY}`);
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual(REQ);
    expect(String(init.body)).not.toMatch(/price|amount|rate/i);
  });

  it("200: returns the order Razorpay needs", async () => {
    const out = await createPanelOrder(REQ, { env: ENV, fetchImpl: reply(200, OK_BODY) });
    expect(out).toEqual({
      kind: "ok",
      order: {
        orderId: "order_X",
        amount: 70800,
        currency: "INR",
        razorpayKeyId: "rzp_test_abc",
        razorpayMode: "test",
        quoteId: "Q-1",
        leadId: "L-1",
        customerName: "Asha Rao",
        totalRupees: 708,
      },
    });
  });

  it("200 without an order id is NOT ok, and says the order may exist", async () => {
    const out = await createPanelOrder(REQ, { env: ENV, fetchImpl: reply(200, { success: true, razorpayKeyId: "k", amount: 1 }) });
    expect(out).toMatchObject({ kind: "unreachable", mayHaveCreated: true });
  });

  it("400: ResellerOS's customer message is passed through with its hints", async () => {
    const out = await createPanelOrder(REQ, {
      env: ENV,
      fetchImpl: reply(400, { error: "rao.in is already registered.", needDomain: true }),
    });
    expect(out).toEqual({ kind: "refused", message: "rao.in is already registered.", needAddress: undefined, needDomain: true, unpriced: undefined });
  });

  it.each([401, 403, 503])("%i: our configuration, never the customer's", async (status) => {
    const out = await createPanelOrder(REQ, { env: ENV, fetchImpl: reply(status, { error: "nope" }) });
    expect(out).toEqual({ kind: "config", status, detail: "nope" });
  });

  it("500: unreachable, and ResellerOS may have allocated a quote", async () => {
    const out = await createPanelOrder(REQ, { env: ENV, fetchImpl: reply(500, { error: "Could not save quote." }) });
    expect(out).toMatchObject({ kind: "unreachable", mayHaveCreated: true });
  });

  it("a refused connection: unreachable, and nothing was created", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const out = await createPanelOrder(REQ, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ kind: "unreachable", mayHaveCreated: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a timeout: unreachable, the order MAY exist, and it is not retried", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const out = await createPanelOrder(REQ, { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ kind: "unreachable", mayHaveCreated: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("panelOrderRefusalMessage", () => {
  it("a config fault says nothing was charged and that it is not the customer's fault", () => {
    const m = panelOrderRefusalMessage({ kind: "config", status: 401, detail: "x" }, "help@example.test");
    expect(m).toMatch(/Nothing was charged/);
    expect(m).toMatch(/not a problem with your details/);
    expect(m).toMatch(/help@example\.test/);
  });
  it("a timed-out order tells the customer to check email and Billing before retrying", () => {
    const m = panelOrderRefusalMessage({ kind: "unreachable", detail: "t", mayHaveCreated: true });
    expect(m).toMatch(/check your email and the Billing page before trying again/);
  });
  it("a refused connection says try again in a few minutes", () => {
    const m = panelOrderRefusalMessage({ kind: "unreachable", detail: "t", mayHaveCreated: false });
    expect(m).toMatch(/try again in a few minutes/);
    expect(m).not.toMatch(/may have been created/);
  });
  it("a customer refusal is ResellerOS's own words", () => {
    expect(panelOrderRefusalMessage({ kind: "refused", message: "Add your address." })).toBe("Add your address.");
  });
});
