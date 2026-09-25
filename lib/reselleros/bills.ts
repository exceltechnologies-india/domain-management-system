/**
 * The signed-in customer's bills — read from RESELLEROS, server-side.
 *
 * Owner decisions 24-25 Sep 2026: DMS issues no bills; every bill is
 * ResellerOS's (decision 29: the paid-order/quote PDF at once, the GST tax
 * invoice once staff issue it). This reads them through ResellerOS's existing
 * integration API (`/api/v1`, docs/dsp-integration-api.md in that repo) with a
 * tenant API key, `RESELLEROS_BILLING_API_KEY`, which never reaches a browser.
 *
 *   GET /customers?email=…              → the customer, or 404 "Customer not found"
 *   GET /customers/{id}/quotes          → paid orders + pending renewals (payment_url)
 *   GET /customers/{id}/invoices        → GST tax invoices (pdf_url)
 *
 * Money in that API is WHOLE RUPEES, not paise.
 *
 * ── What a failure is allowed to look like (AGENTS.md §2) ────────────────
 * "No bills yet" is ONLY the customer lookup's 404. Everything else that goes
 * wrong — unreachable, timeout, 5xx, a bad key, an unreadable body, and a 404
 * on the quotes/invoices calls (ResellerOS answers a database error there with
 * 404 "Could not load quotes") — is `unavailable`, and the page says the bills
 * could not be loaded. An empty list is never shown in place of a failure.
 *
 * ── Whose bills these are ────────────────────────────────────────────────
 * ResellerOS matches `?email=` with a case-insensitive `ilike`, so `_` and
 * `%` in an address act as wildcards there, and it can also match through a
 * contact person's email. Showing another customer's bills would be a data
 * leak, so this fails CLOSED: the customer record ResellerOS returns must
 * carry exactly this email (case-insensitive), or nothing is shown and the
 * customer is told to contact support.
 */
import { supportEmail } from "./panel-order";

export interface ResellerOsQuote {
  id: string;
  /** Whole rupees. */
  amount: number;
  currency: string;
  status: "pending" | "accepted" | "expired";
  pdfUrl: string | null;
  paymentUrl: string | null;
}

export interface ResellerOsInvoice {
  id: string;
  number: string;
  /** Whole rupees. */
  amount: number;
  currency: string;
  status: string;
  issueDate: string | null;
  dueDate: string | null;
  pdfUrl: string | null;
}

export type BillsOutcome =
  | { kind: "ok"; customerId: string; quotes: ResellerOsQuote[]; invoices: ResellerOsInvoice[] }
  | { kind: "no_bills" }
  | { kind: "not_configured"; missing: string[] }
  | { kind: "unavailable"; detail: string }
  | { kind: "not_confirmed"; detail: string };

const DEFAULT_TIMEOUT_MS = 10_000;

export function readBillsConfig(
  env: Record<string, string | undefined> = process.env,
): { ok: true; baseUrl: string; apiKey: string } | { ok: false; missing: string[] } {
  const rawUrl = (env.RESELLEROS_SERVER_URL ?? "").trim();
  const apiKey = (env.RESELLEROS_BILLING_API_KEY ?? "").trim();
  const missing: string[] = [];
  if (!/^https?:\/\//i.test(rawUrl)) missing.push("RESELLEROS_SERVER_URL");
  if (!apiKey) missing.push("RESELLEROS_BILLING_API_KEY");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, baseUrl: `${rawUrl.replace(/\/+$/, "")}/api/v1`, apiKey };
}

class Unavailable extends Error {}

/** Only an http(s) link may become an href; anything else is dropped, never rendered. */
function safeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^https?:\/\//i.test(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function rupees(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Unavailable(`${what} has no readable amount`);
  return v;
}

function parseQuotes(body: unknown): ResellerOsQuote[] {
  if (!Array.isArray(body)) throw new Unavailable("quotes response is not a list");
  return body.map((q: unknown, i) => {
    const r = (q ?? {}) as Record<string, unknown>;
    const id = str(r.id);
    if (!id) throw new Unavailable(`quote ${i} has no id`);
    const status = r.status === "pending" || r.status === "accepted" || r.status === "expired" ? r.status : null;
    if (!status) throw new Unavailable(`quote ${id} has an unknown status`);
    return {
      id,
      amount: rupees(r.amount, `quote ${id}`),
      currency: str(r.currency) ?? "INR",
      status,
      pdfUrl: safeUrl(r.pdf_url),
      paymentUrl: safeUrl(r.payment_url),
    };
  });
}

function parseInvoices(body: unknown): ResellerOsInvoice[] {
  if (!Array.isArray(body)) throw new Unavailable("invoices response is not a list");
  return body.map((v: unknown, i) => {
    const r = (v ?? {}) as Record<string, unknown>;
    const id = str(r.id);
    if (!id) throw new Unavailable(`invoice ${i} has no id`);
    return {
      id,
      number: str(r.number) ?? id,
      amount: rupees(r.amount, `invoice ${id}`),
      currency: str(r.currency) ?? "INR",
      status: str(r.status) ?? "unknown",
      issueDate: str(r.issue_date),
      dueDate: str(r.due_date),
      pdfUrl: safeUrl(r.pdf_url),
    };
  });
}

export interface FetchBillsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export async function fetchCustomerBills(email: string, options: FetchBillsOptions = {}): Promise<BillsOutcome> {
  const cfg = readBillsConfig(options.env);
  if (!cfg.ok) return { kind: "not_configured", missing: cfg.missing };
  const wanted = email.trim().toLowerCase();
  if (!wanted) return { kind: "not_confirmed", detail: "the account has no email address" };

  const { baseUrl, apiKey } = cfg;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Unavailable(`GET ${path.split("?")[0]} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  try {
    const lookup = await get(`/customers?email=${encodeURIComponent(wanted)}`);
    if (lookup.status === 404) return { kind: "no_bills" };
    if (lookup.status !== 200) {
      throw new Unavailable(`customer lookup answered HTTP ${lookup.status}`);
    }
    const c = (lookup.body ?? {}) as Record<string, unknown>;
    const customerId = str(c.billing_customer_id) ?? str(c.id);
    if (!customerId) throw new Unavailable("customer lookup returned no billing_customer_id");
    const theirEmail = (str(c.email) ?? "").trim().toLowerCase();
    if (theirEmail !== wanted) {
      return {
        kind: "not_confirmed",
        detail: `ResellerOS matched customer ${customerId} whose email is not this account's`,
      };
    }

    const enc = encodeURIComponent(customerId);
    const [q, inv] = await Promise.all([get(`/customers/${enc}/quotes`), get(`/customers/${enc}/invoices`)]);
    // A 404 here is NOT "no bills": the customer exists, and ResellerOS
    // answers a failed read of their quotes/invoices with 404.
    if (q.status !== 200) throw new Unavailable(`quotes answered HTTP ${q.status}`);
    if (inv.status !== 200) throw new Unavailable(`invoices answered HTTP ${inv.status}`);
    return { kind: "ok", customerId, quotes: parseQuotes(q.body), invoices: parseInvoices(inv.body) };
  } catch (err) {
    if (err instanceof Unavailable) return { kind: "unavailable", detail: err.message };
    throw err;
  }
}

/** What the customer is told when the bills cannot be shown. §7: what, why, what next. */
export function billsUnavailableMessage(
  outcome: Extract<BillsOutcome, { kind: "not_configured" | "unavailable" | "not_confirmed" }>,
  support: string = supportEmail(),
): string {
  switch (outcome.kind) {
    case "not_configured":
    case "unavailable":
      return (
        "We couldn't load your bills right now. This does not mean you have none — our billing system didn't answer. " +
        `Your bills are also in your email. Please refresh in a few minutes, or email ${support} for a copy.`
      );
    case "not_confirmed":
      return (
        "We couldn't confirm which bills belong to your account, so none are shown here. " +
        `Your bills are in your email; for help, email ${support} and we'll link your account.`
      );
  }
}
