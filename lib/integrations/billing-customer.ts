/**
 * Phase A integration: Billing Panel (ResellerOS) customer lookup + read-only
 * billing detail for the admin "Billing" tab. Server-to-server, read-only —
 * never creates or modifies a Billing customer record.
 *
 * Identity: Billing's `customer_number` (e.g. "C-00001"), stored on our User
 * as `billingCustomerId` once matched. Matching is lazy — by email — the
 * first time an admin opens a user's Billing tab; never run in bulk.
 *
 * Best-effort: Billing being unreachable/misconfigured should never break
 * the admin page, so failures resolve to "not linked" instead of throwing.
 */

import { serverLogger } from "@/lib/server-logger";

export interface BillingCustomerLookup {
  billing_customer_id: string;
  name: string;
  email: string;
  domain: string | null;
  status: "active" | "inactive";
}

export interface BillingSubscription {
  id: string;
  product: string;
  plan: string;
  seats: number;
  status: "active" | "suspended" | "expired" | "cancelled";
  start_date: string;
  renewal_date: string;
  amount: number;
  currency: string;
  vendor?: string;
}

export interface BillingInvoice {
  id: string;
  number: string;
  amount: number;
  currency: string;
  status: "paid" | "unpaid" | "overdue" | "cancelled";
  issue_date: string;
  due_date: string;
  pdf_url: string;
}

export interface BillingQuote {
  id: string;
  amount: number;
  currency: string;
  status: "pending" | "accepted" | "expired";
  pdf_url: string;
  payment_url: string;
}

export interface BillingPayment {
  id: string;
  amount: number;
  currency: string;
  reference: string;
  method: string;
  paid_at: string;
  invoice_id: string | null;
}

export interface BillingCustomerDetails {
  customer: BillingCustomerLookup;
  subscriptions: BillingSubscription[];
  invoices: BillingInvoice[];
  quotes: BillingQuote[];
  payments: BillingPayment[];
}

function config() {
  const apiUrl = process.env.BILLING_API_URL;
  const apiKey = process.env.BILLING_INTEGRATION_API_KEY;
  if (!apiUrl || !apiKey) return null;
  return { apiUrl: apiUrl.replace(/\/$/, ""), apiKey };
}

async function billingFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T | null> {
  const cfg = config();
  if (!cfg) {
    serverLogger.warn("[billing-customer] BILLING_API_URL/BILLING_INTEGRATION_API_KEY not configured — skipping");
    return null;
  }
  try {
    const res = await fetch(`${cfg.apiUrl}/api/v1${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      serverLogger.warn(`[billing-customer] Billing returned ${res.status} for ${path}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    serverLogger.warn(`[billing-customer] request failed for ${path}`, error);
    return null;
  }
}

/**
 * Best-effort status propagation — a Customer Panel account was
 * deactivated/reactivated, so tell Billing to stop/resume renewal
 * reminders and new invoices for the linked customer. Fire-and-forget by
 * design: this must never block or fail the actual user operation
 * (deactivate/reactivate/delete) it's attached to.
 */
export async function notifyBillingCustomerStatus(
  billingCustomerId: string,
  isActive: boolean
): Promise<void> {
  await billingFetch(`/customers/${encodeURIComponent(billingCustomerId)}`, {
    method: "PATCH",
    body: { is_active: isActive },
  });
}

/** Lazy match by email — does NOT create anything in Billing. */
export async function lookupBillingCustomerByEmail(
  email: string
): Promise<BillingCustomerLookup | null> {
  // 404 (no match) resolves to null via billingFetch's !res.ok handling.
  return billingFetch<BillingCustomerLookup>(`/customers?email=${encodeURIComponent(email)}`);
}

/**
 * Create-or-link a Billing contact for this person (identity only — no
 * invoice, no subscription). Used by (a) the admin "Also create Billing
 * account" checkbox on manual customer creation and (b) the purchase-
 * success sync. Idempotent on Billing's side by email, so calling this
 * more than once for the same person just re-links, never duplicates.
 */
export async function provisionBillingCustomer(input: {
  name: string;
  email: string;
}): Promise<BillingCustomerLookup | null> {
  return billingFetch<BillingCustomerLookup>("/customers", { method: "POST", body: input });
}

export interface BillingInvoiceLineItem {
  description: string;
  qty: number;
  rate: number;
}

export interface BillingRenewalItem {
  itemType: "domain" | "hosting";
  domainName: string;
  /** YYYY-MM-DD */
  renewalDate: string;
  amount: number;
  /** DirectAdmin username for hosting items — what Customer Panel needs to
   * actually execute a suspend if Billing ever decides one is due. No
   * equivalent needed for domains (the domainName itself is enough). */
  externalRef?: string;
}

export interface BillingInvoiceResult {
  billingCustomerId: string;
  invoiceId: string;
  invoiceNumber: string;
  pdfUrl: string;
}

/**
 * Create a real, GST-compliant invoice in Billing for an order whose
 * payment is already confirmed (Razorpay). Throws on failure — callers
 * (post-tasks.ts) wrap this in the same claim/retry pattern already used
 * for Zoho, so a thrown error here surfaces the same way a Zoho failure
 * does. Never silently returns null, unlike the read-only helpers above.
 */
export async function createBillingInvoice(input: {
  email: string;
  name: string;
  lineItems: BillingInvoiceLineItem[];
  amount: number;
  razorpayPaymentId: string;
  /** Stage 1: one subscription-tracking row per item, so Billing's renewal
   * cron can pick these up later. Optional — omitting it just skips
   * renewal tracking for this invoice. */
  renewalItems?: BillingRenewalItem[];
}): Promise<BillingInvoiceResult> {
  const cfg = config();
  if (!cfg) {
    throw new Error("BILLING_API_URL/BILLING_INTEGRATION_API_KEY not configured");
  }
  const res = await fetch(`${cfg.apiUrl}/api/v1/invoices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `Billing invoice creation failed (${res.status})`);
  }
  return {
    billingCustomerId: body.billing_customer_id,
    invoiceId: body.id,
    invoiceNumber: body.number,
    pdfUrl: body.pdf_url,
  };
}

/**
 * Just the quotes list — used for the customer-facing Billing tab's
 * "Pending Amount" sub-tab. Each quote carries its own payment_url (a
 * public accept-link on Billing's side, handled entirely by Billing — no
 * new payment code needed here) and pdf_url.
 */
export async function getBillingQuotes(billingCustomerId: string): Promise<BillingQuote[]> {
  return (
    (await billingFetch<BillingQuote[]>(
      `/customers/${encodeURIComponent(billingCustomerId)}/quotes`
    )) ?? []
  );
}

/**
 * Just the invoices list — used to fill in Billing-native invoices on the
 * customer-facing Invoices tab (ones created directly in Billing's own UI,
 * e.g. by staff, rather than through a Customer Panel checkout — those
 * never get an Order row here, so without this fetch they'd never show up).
 */
export async function getBillingInvoices(billingCustomerId: string): Promise<BillingInvoice[]> {
  return (
    (await billingFetch<BillingInvoice[]>(
      `/customers/${encodeURIComponent(billingCustomerId)}/invoices`
    )) ?? []
  );
}

/**
 * Just the subscriptions list — used for the customer-facing "My Services"
 * tab, which only needs name/status/renewal/price, not the full detail
 * bundle (invoices/quotes/payments) the admin Billing tab pulls.
 */
export async function getBillingSubscriptions(
  billingCustomerId: string
): Promise<BillingSubscription[]> {
  return (
    (await billingFetch<BillingSubscription[]>(
      `/customers/${encodeURIComponent(billingCustomerId)}/subscriptions`
    )) ?? []
  );
}

export async function getBillingCustomerDetails(
  billingCustomerId: string
): Promise<BillingCustomerDetails | null> {
  const [customer, subscriptions, invoices, quotes, payments] = await Promise.all([
    billingFetch<BillingCustomerLookup>(`/customers/${encodeURIComponent(billingCustomerId)}`),
    billingFetch<BillingSubscription[]>(`/customers/${encodeURIComponent(billingCustomerId)}/subscriptions`),
    billingFetch<BillingInvoice[]>(`/customers/${encodeURIComponent(billingCustomerId)}/invoices`),
    billingFetch<BillingQuote[]>(`/customers/${encodeURIComponent(billingCustomerId)}/quotes`),
    billingFetch<BillingPayment[]>(`/customers/${encodeURIComponent(billingCustomerId)}/payments`),
  ]);
  if (!customer) return null;
  return {
    customer,
    subscriptions: subscriptions ?? [],
    invoices: invoices ?? [],
    quotes: quotes ?? [],
    payments: payments ?? [],
  };
}
