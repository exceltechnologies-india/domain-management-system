/**
 * lib/reselleros/bills.ts — reading the customer's ResellerOS bills.
 *
 * Pinned: "no bills" is ONLY the customer lookup's 404; every other failure
 * is `unavailable` (never an empty list); a customer whose email is not this
 * account's is never shown; links that are not http(s) are dropped.
 */
// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { billsUnavailableMessage, fetchCustomerBills, readBillsConfig } from "@/lib/reselleros/bills";

const ENV = { RESELLEROS_SERVER_URL: "https://ros.example.test", RESELLEROS_BILLING_API_KEY: "rsk_live_abc" };

type Route = { status: number; body: unknown } | Error;

function router(routes: Record<string, Route>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const r = routes[key];
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}

const CUSTOMER = { billing_customer_id: "C-00007", name: "Asha", email: "Asha@Example.test", status: "active" };
const QUOTES = [
  { id: "Q-1", amount: 708, currency: "INR", status: "accepted", pdf_url: "https://ros.example.test/q1.pdf?token=t", payment_url: "https://ros.example.test/quote/Q-1/accept" },
  { id: "Q-2", amount: 708, currency: "INR", status: "pending", pdf_url: "https://ros.example.test/q2.pdf", payment_url: "https://ros.example.test/quote/Q-2/accept" },
];
const INVOICES = [
  { id: "INV-1", number: "INV-1", amount: 708, currency: "INR", status: "paid", issue_date: "2026-09-25", due_date: "2026-10-25", pdf_url: "https://ros.example.test/i1.pdf" },
];

describe("readBillsConfig", () => {
  it("names both missing settings", () => {
    expect(readBillsConfig({})).toEqual({ ok: false, missing: ["RESELLEROS_SERVER_URL", "RESELLEROS_BILLING_API_KEY"] });
  });
  it("points at /api/v1", () => {
    const c = readBillsConfig({ ...ENV, RESELLEROS_SERVER_URL: "https://ros.example.test/" });
    expect(c.ok && c.baseUrl).toBe("https://ros.example.test/api/v1");
  });
});

describe("fetchCustomerBills", () => {
  it("not configured: no request is made", async () => {
    const f = vi.fn();
    const out = await fetchCustomerBills("a@b.test", { env: {}, fetchImpl: f as unknown as typeof fetch });
    expect(out.kind).toBe("not_configured");
    expect(f).not.toHaveBeenCalled();
  });

  it("customer lookup 404 → no_bills", async () => {
    const out = await fetchCustomerBills("asha@example.test", {
      env: ENV,
      fetchImpl: router({ "/customers?email=": { status: 404, body: { error: "Customer not found" } } }),
    });
    expect(out).toEqual({ kind: "no_bills" });
  });

  it("ok: quotes and invoices, sent with the key and the lower-cased email", async () => {
    const f = router({
      "/customers?email=": { status: 200, body: CUSTOMER },
      "/customers/C-00007/quotes": { status: 200, body: QUOTES },
      "/customers/C-00007/invoices": { status: 200, body: INVOICES },
    });
    const out = await fetchCustomerBills(" Asha@Example.test ", { env: ENV, fetchImpl: f });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.quotes.map((q) => [q.id, q.status, q.paymentUrl !== null])).toEqual([
      ["Q-1", "accepted", true],
      ["Q-2", "pending", true],
    ]);
    expect(out.invoices[0]).toMatchObject({ number: "INV-1", amount: 708, pdfUrl: "https://ros.example.test/i1.pdf" });
    // The fixture sends no `renews`: that is "not said" (null), never guessed into "renews nothing".
    expect(out.quotes.map((q) => q.renews)).toEqual([null, null]);
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("https://ros.example.test/api/v1/customers?email=asha%40example.test");
    expect((calls[0][1].headers as Record<string, string>).authorization).toBe("Bearer rsk_live_abc");
  });

  it("carries what each quote renews; a malformed `renews` is null, not []", async () => {
    const quotes = [
      { ...QUOTES[1], id: "Q-R", renews: [{ vendor: "hosting", domain: "acme.in" }] },
      { ...QUOTES[1], id: "Q-N", renews: [] },
      { ...QUOTES[1], id: "Q-X", renews: [{ domain: "acme.in" }] },
    ];
    const out = await fetchCustomerBills("asha@example.test", {
      env: ENV,
      fetchImpl: router({
        "/customers?email=": { status: 200, body: CUSTOMER },
        "/customers/C-00007/quotes": { status: 200, body: quotes },
        "/customers/C-00007/invoices": { status: 200, body: [] },
      }),
    });
    if (out.kind !== "ok") throw new Error(out.kind);
    expect(out.quotes.map((q) => [q.id, q.renews])).toEqual([
      ["Q-R", [{ vendor: "hosting", domain: "acme.in" }]],
      ["Q-N", []],
      ["Q-X", null],
    ]);
  });

  it("a 404 on the quotes call is NOT 'no bills' — it is unavailable", async () => {
    const out = await fetchCustomerBills("asha@example.test", {
      env: ENV,
      fetchImpl: router({
        "/customers?email=": { status: 200, body: CUSTOMER },
        "/customers/C-00007/quotes": { status: 404, body: { error: "Could not load quotes" } },
        "/customers/C-00007/invoices": { status: 200, body: INVOICES },
      }),
    });
    expect(out.kind).toBe("unavailable");
  });

  it.each([401, 500, 503])("customer lookup HTTP %i → unavailable, never an empty list", async (status) => {
    const out = await fetchCustomerBills("asha@example.test", {
      env: ENV,
      fetchImpl: router({ "/customers?email=": { status, body: { error: "x" } } }),
    });
    expect(out.kind).toBe("unavailable");
  });

  it("network failure → unavailable", async () => {
    const out = await fetchCustomerBills("asha@example.test", {
      env: ENV,
      fetchImpl: router({ "/customers?email=": new TypeError("fetch failed") }),
    });
    expect(out.kind).toBe("unavailable");
  });

  it("an unreadable list → unavailable (a missing amount is not ₹0)", async () => {
    const out = await fetchCustomerBills("asha@example.test", {
      env: ENV,
      fetchImpl: router({
        "/customers?email=": { status: 200, body: CUSTOMER },
        "/customers/C-00007/quotes": { status: 200, body: [{ id: "Q-9", status: "pending" }] },
        "/customers/C-00007/invoices": { status: 200, body: [] },
      }),
    });
    expect(out.kind).toBe("unavailable");
  });

  it("a customer whose email is not this account's is never shown (ilike wildcards, contact matches)", async () => {
    const f = router({
      "/customers?email=": { status: 200, body: { ...CUSTOMER, email: "axb@example.test" } },
    });
    const out = await fetchCustomerBills("a_b@example.test", { env: ENV, fetchImpl: f });
    expect(out.kind).toBe("not_confirmed");
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("a javascript: link is dropped, not rendered", async () => {
    const out = await fetchCustomerBills("asha@example.test", {
      env: ENV,
      fetchImpl: router({
        "/customers?email=": { status: 200, body: CUSTOMER },
        "/customers/C-00007/quotes": { status: 200, body: [{ ...QUOTES[1], payment_url: "javascript:alert(1)" }] },
        "/customers/C-00007/invoices": { status: 200, body: [] },
      }),
    });
    expect(out.kind === "ok" && out.quotes[0].paymentUrl).toBeNull();
  });
});

describe("billsUnavailableMessage", () => {
  it("says it does not mean there are no bills, and what to do", () => {
    const m = billsUnavailableMessage({ kind: "unavailable", detail: "x" }, "help@example.test");
    expect(m).toMatch(/does not mean you have none/);
    expect(m).toMatch(/help@example\.test/);
  });
});

/* 28 Sep 2026: ResellerOS builds bill links from the address DMS's SERVER called it on.
   Locally that is host.docker.internal, which a customer's browser cannot open — the
   end-to-end run on 26 Sep found the Invoices page's PDF link dead. */
describe("bill links point at ResellerOS's PUBLIC address", () => {
  const INTERNAL = { RESELLEROS_SERVER_URL: "http://host.docker.internal:4320", RESELLEROS_BILLING_API_KEY: "rsk_live_abc" };
  const routes = (pdf: string, pay: string) =>
    router({
      "/customers?email=": { status: 200, body: CUSTOMER },
      "/customers/C-00007/quotes": { status: 200, body: [{ ...QUOTES[1], pdf_url: pdf, payment_url: pay }] },
      "/customers/C-00007/invoices": { status: 200, body: [{ ...INVOICES[0], pdf_url: pdf }] },
    });
  const pdf = "http://host.docker.internal:4320/api/v1/documents/quote/Q-2/pdf?token=abc123";
  const pay = "http://host.docker.internal:4320/quote/Q-2/accept?t=tok";

  it("a link on the server address moves to the public address, path and token unchanged", async () => {
    const out = await fetchCustomerBills("asha@example.test", {
      env: { ...INTERNAL, NEXT_PUBLIC_RESELLEROS_URL: "http://localhost:4320/" },
      fetchImpl: routes(pdf, pay),
    });
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(out.quotes[0].pdfUrl).toBe("http://localhost:4320/api/v1/documents/quote/Q-2/pdf?token=abc123");
    expect(out.quotes[0].paymentUrl).toBe("http://localhost:4320/quote/Q-2/accept?t=tok");
    expect(out.invoices[0].pdfUrl).toBe("http://localhost:4320/api/v1/documents/quote/Q-2/pdf?token=abc123");
  });

  it("no public address configured → links are kept exactly as ResellerOS sent them", async () => {
    const out = await fetchCustomerBills("asha@example.test", { env: INTERNAL, fetchImpl: routes(pdf, pay) });
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(out.quotes[0].pdfUrl).toBe(pdf);
  });

  it("a link on any other address is left alone; a non-http link is still dropped", async () => {
    const out = await fetchCustomerBills("asha@example.test", {
      env: { ...INTERNAL, NEXT_PUBLIC_RESELLEROS_URL: "https://reselleros.example.test" },
      fetchImpl: routes("https://cdn.example.test/q2.pdf", "javascript:alert(1)"),
    });
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(out.quotes[0].pdfUrl).toBe("https://cdn.example.test/q2.pdf");
    expect(out.quotes[0].paymentUrl).toBeNull();
  });
});
