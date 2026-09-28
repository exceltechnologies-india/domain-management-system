/**
 * lib/reselleros/renewal-order.ts — asks ResellerOS to open a Razorpay order for an existing
 * renewal bill, so it can be paid inside the panel (owner, 28 Sep 2026).
 *
 * Pinned: unusable config refuses before any request; the request carries the panel key, the
 * quote id and the session's identity, and no price; each answer lands in the class of who can
 * fix it; ResellerOS's customer-facing refusal is passed through as written; one fetch per call.
 */
// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { createRenewalOrder, renewalOrderRefusalMessage } from "@/lib/reselleros/renewal-order";

const ENV = { RESELLEROS_SERVER_URL: "https://ros.example.test/", DMS_PANEL_API_KEY: "k".repeat(24) };
const REQ = { quoteId: "Q-R-1", email: "asha@example.test", dmsUserId: "abc123" };
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const OK = { success: true, orderId: "order_R", amount: 70800, currency: "INR", razorpayKeyId: "rzp_test_k", quoteId: "Q-R-1" };

describe("createRenewalOrder", () => {
  it("refuses without a server URL or panel key, and sends nothing", async () => {
    const f = reply(200, OK);
    const out = await createRenewalOrder(REQ, { env: { RESELLEROS_SERVER_URL: "ros.example.test", DMS_PANEL_API_KEY: "short" }, fetchImpl: f });
    expect(out).toEqual({ kind: "not_configured", missing: ["RESELLEROS_SERVER_URL", "DMS_PANEL_API_KEY"] });
    expect(f).not.toHaveBeenCalled();
  });

  it("posts the quote and identity with the panel key to /api/dms/renewal-order — once, with no price", async () => {
    const f = reply(200, OK);
    const out = await createRenewalOrder(REQ, { env: ENV, fetchImpl: f });
    expect(out).toEqual({ kind: "ok", order: { orderId: "order_R", amount: 70800, currency: "INR", razorpayKeyId: "rzp_test_k", quoteId: "Q-R-1" } });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ros.example.test/api/dms/renewal-order");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${"k".repeat(24)}`);
    expect(JSON.parse(String(init.body))).toEqual(REQ);
  });

  it("a 200 without a usable order is not treated as success", async () => {
    const out = await createRenewalOrder(REQ, { env: ENV, fetchImpl: reply(200, { success: true, orderId: "order_R" }) });
    expect(out.kind).toBe("unreachable");
  });

  it.each([400, 404, 409])("HTTP %i → refused, with ResellerOS's own sentence", async (status) => {
    const out = await createRenewalOrder(REQ, { env: ENV, fetchImpl: reply(status, { error: "This quote is already paid." }) });
    expect(out).toEqual({ kind: "refused", status, message: "This quote is already paid." });
  });

  it.each([401, 403, 503])("HTTP %i → a config fault on our side", async (status) => {
    const out = await createRenewalOrder(REQ, { env: ENV, fetchImpl: reply(status, { error: "x" }) });
    expect(out.kind).toBe("config");
  });

  it("a network failure or a 5xx → unreachable, not retried", async () => {
    const boom = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect((await createRenewalOrder(REQ, { env: ENV, fetchImpl: boom })).kind).toBe("unreachable");
    expect(boom).toHaveBeenCalledTimes(1);
    expect((await createRenewalOrder(REQ, { env: ENV, fetchImpl: reply(500, {}) })).kind).toBe("unreachable");
  });
});

describe("renewalOrderRefusalMessage", () => {
  it("every failure says nothing was charged and what to do next", () => {
    for (const o of [
      { kind: "not_configured" as const, missing: ["DMS_PANEL_API_KEY"] },
      { kind: "config" as const, status: 503, detail: "x" },
      { kind: "unreachable" as const, detail: "x" },
    ]) {
      const m = renewalOrderRefusalMessage(o, "help@example.test");
      expect(m).toMatch(/Nothing was charged/);
      expect(m).toMatch(/renewal email|help@example\.test/);
    }
    expect(renewalOrderRefusalMessage({ kind: "refused", status: 404, message: "Not yours." })).toBe("Not yours.");
  });
});
