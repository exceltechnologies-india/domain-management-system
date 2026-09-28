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

/** A service a ResellerOS quote renews (its subscription's vendor and domain). */
export interface QuoteRenews {
  vendor: string;
  domain: string | null;
}

export interface ResellerOsQuote {
  id: string;
  /** Whole rupees. */
  amount: number;
  currency: string;
  status: "pending" | "accepted" | "expired";
  pdfUrl: string | null;
  paymentUrl: string | null;
  /**
   * What the quote renews, from ResellerOS (28 Sep 2026): [] = renews nothing (a new order);
   * null = ResellerOS did not say (an older ResellerOS), so it cannot be matched to a service.
   */
  renews: QuoteRenews[] | null;
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

/** The origin (`scheme://host[:port]`) of an http(s) address, or null when it is not one. */
function originOf(v: string): string | null {
  if (!/^https?:\/\//i.test(v)) return null;
  try {
    return new URL(v).origin;
  } catch {
    return null;
  }
}

export function readBillsConfig(
  env: Record<string, string | undefined> = process.env,
):
  | { ok: true; baseUrl: string; apiKey: string; serverOrigin: string; publicOrigin: string | null }
  | { ok: false; missing: string[] } {
  const rawUrl = (env.RESELLEROS_SERVER_URL ?? "").trim();
  const apiKey = (env.RESELLEROS_BILLING_API_KEY ?? "").trim();
  const missing: string[] = [];
  const serverOrigin = originOf(rawUrl);
  if (!serverOrigin) missing.push("RESELLEROS_SERVER_URL");
  if (!apiKey) missing.push("RESELLEROS_BILLING_API_KEY");
  if (missing.length > 0 || !serverOrigin) return { ok: false, missing };
  return {
    ok: true,
    baseUrl: `${rawUrl.replace(/\/+$/, "")}/api/v1`,
    apiKey,
    serverOrigin,
    // Where a CUSTOMER's browser reaches ResellerOS (lib/reseller-os.ts). Not required:
    // when it is unknown the links are left exactly as ResellerOS sent them.
    publicOrigin: originOf((env.NEXT_PUBLIC_RESELLEROS_URL ?? "").trim()),
  };
}

class Unavailable extends Error {}

/**
 * Makes a bill link one the customer's browser can open (28 Sep 2026).
 *
 * ResellerOS builds `pdf_url` / `payment_url` from the address THIS server called it on,
 * `RESELLEROS_SERVER_URL`. That is the server-to-server address, and it need not be one a
 * browser can reach: locally it is `http://host.docker.internal:4320`, and the end-to-end
 * run on 26 Sep 2026 found the Invoices page's PDF link dead because of it, while the same
 * PDF opened fine on the public address. So a link on the server address is moved to the
 * public address (`NEXT_PUBLIC_RESELLEROS_URL`), keeping its path and token exactly.
 *
 * Only a link on the server origin is rewritten; any other http(s) link is kept as sent,
 * and anything that is not http(s) is dropped, never rendered.
 */
function customerLink(v: unknown, serverOrigin: string, publicOrigin: string | null): string | null {
  if (typeof v !== "string" || !originOf(v)) return null;
  const u = new URL(v);
  if (publicOrigin && u.origin === serverOrigin && publicOrigin !== serverOrigin) {
    return `${publicOrigin}${u.pathname}${u.search}${u.hash}`;
  }
  return v;
}

type LinkFix = (v: unknown) => string | null;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function rupees(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Unavailable(`${what} has no readable amount`);
  return v;
}

function parseQuotes(body: unknown, safeUrl: LinkFix): ResellerOsQuote[] {
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
      renews: parseRenews(r.renews),
    };
  });
}

/** `renews` as sent, or null when absent or unreadable — never guessed into []. */
function parseRenews(v: unknown): QuoteRenews[] | null {
  if (!Array.isArray(v)) return null;
  const out: QuoteRenews[] = [];
  for (const item of v) {
    const r = (item ?? {}) as Record<string, unknown>;
    if (typeof r.vendor !== "string") return null;
    out.push({ vendor: r.vendor, domain: typeof r.domain === "string" && r.domain.trim() ? r.domain : null });
  }
  return out;
}

function parseInvoices(body: unknown, safeUrl: LinkFix): ResellerOsInvoice[] {
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
    const link: LinkFix = (v) => customerLink(v, cfg.serverOrigin, cfg.publicOrigin);
    return { kind: "ok", customerId, quotes: parseQuotes(q.body, link), invoices: parseInvoices(inv.body, link) };
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
