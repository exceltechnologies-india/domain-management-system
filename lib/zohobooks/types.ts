/**
 * Shared types for Zoho Books API responses + the user/order shapes
 * the integration consumes from the app side.
 *
 * Zoho's API consistently wraps responses in `{ code, message, ... }` —
 * `code: 0` means success; non-zero codes have documented meanings (e.g.
 * `2` = validation, `3062` = duplicate contact, `103001` = subscription
 * expired). Specific endpoints add their own payload field on top:
 * `contacts` / `contact` for the contact endpoints, `invoice` /
 * `invoices` for invoices, etc.
 *
 * All record types carry an open index signature so future Zoho fields
 * don't break compilation — Zoho ships new fields regularly without
 * versioning the API.
 */

import { AxiosError } from "axios";
import type { ZohoInvoice } from "@/lib/types";

export type { ZohoInvoice };

// ─── API envelope ─────────────────────────────────────────────────────────────

/**
 * The wrapper every Zoho Books response shares. `code: 0` = success; any
 * other code is an error condition the caller must inspect `message` /
 * `error_info` for.
 */
export interface ZohoApiEnvelope {
  code: number;
  message?: string;
  [k: string]: unknown;
}

/** Endpoints that return `{ contacts: [...] }` for list / search ops. */
export interface ZohoContactsListResponse extends ZohoApiEnvelope {
  contacts: ZohoContact[];
  page_context?: ZohoPageContext;
}

/** Endpoints that return `{ contact: {...} }` for single-record ops. */
export interface ZohoContactResponse extends ZohoApiEnvelope {
  contact: ZohoContact;
}

/** `{ contact_persons: [...] }` from the contact-persons endpoint. */
export interface ZohoContactPersonsResponse extends ZohoApiEnvelope {
  contact_persons: ZohoContactPerson[];
}

/** Invoice list endpoints — `{ invoices: [...], page_context }`. */
export interface ZohoInvoicesListResponse extends ZohoApiEnvelope {
  invoices: ZohoInvoice[];
  page_context?: ZohoPageContext;
}

/** Single-invoice endpoints — `{ invoice: {...} }`. */
export interface ZohoInvoiceResponse extends ZohoApiEnvelope {
  invoice: ZohoInvoice;
}

/** Credit-note endpoints — `{ creditnote: {...} }`. */
export interface ZohoCreditNoteResponse extends ZohoApiEnvelope {
  creditnote: ZohoCreditNote;
}

/** Recurring-invoice endpoints — `{ recurring_invoice: {...} }`. */
export interface ZohoRecurringInvoiceResponse extends ZohoApiEnvelope {
  recurring_invoice: ZohoRecurringInvoice;
}

/** Organization endpoints — `{ organization: {...} }` or list variant. */
export interface ZohoOrganizationResponse extends ZohoApiEnvelope {
  organization?: ZohoOrganization;
  organizations?: ZohoOrganization[];
}

export interface ZohoPageContext {
  page: number;
  per_page: number;
  has_more_page?: boolean;
  total?: number;
  [k: string]: unknown;
}

// ─── Record shapes ────────────────────────────────────────────────────────────

export interface ZohoBillingAddress {
  address?: string;
  street2?: string;
  city?: string;
  state?: string;
  state_code?: string;
  zip?: string;
  country?: string;
  [k: string]: unknown;
}

export interface ZohoContactPerson {
  contact_person_id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  is_primary_contact?: boolean;
  [k: string]: unknown;
}

export interface ZohoContact {
  contact_id: string;
  contact_name?: string;
  company_name?: string;
  contact_type?: string;
  email?: string;
  phone?: string;
  gst_no?: string;
  gst_treatment?: "business_registered" | "consumer" | (string & {});
  billing_address?: ZohoBillingAddress;
  contact_persons?: ZohoContactPerson[];
  [k: string]: unknown;
}

export interface ZohoLineItem {
  item_id?: string;
  name?: string;
  description?: string;
  rate?: number;
  quantity?: number;
  unit?: string;
  hsn_or_sac?: string;
  tax_id?: string;
  tax_name?: string;
  tax_percentage?: number;
  item_total?: number;
  [k: string]: unknown;
}

// ZohoInvoice is re-exported from `@/lib/types` above — keeping a single
// authoritative definition. The Zoho-Books module uses these additional
// per-line-item / per-credit-note shapes locally.

export interface ZohoCreditNote {
  creditnote_id: string;
  creditnote_number?: string;
  reference_number?: string;
  customer_id?: string;
  status?: string;
  date?: string;
  total?: number;
  balance?: number;
  [k: string]: unknown;
}

export interface ZohoRecurringInvoice {
  recurring_invoice_id: string;
  customer_id?: string;
  status?: string;
  recurrence_frequency?: string;
  recurrence_period?: number;
  next_invoice_date?: string;
  [k: string]: unknown;
}

export interface ZohoOrganization {
  organization_id: string;
  name?: string;
  currency_code?: string;
  time_zone?: string;
  state?: string;
  state_code?: string;
  [k: string]: unknown;
}

// ─── App-side input shapes ────────────────────────────────────────────────────
//
// These describe what fields the Zoho integration reads from app objects.
// They intentionally don't import IUser / IOrder from `@/models/*` to avoid
// a module circular dep — and they only declare fields the Zoho code
// actually touches. Anything wider than what's listed should not be added
// here speculatively.

/** Address fields the contact-create flow reads off a User. */
export interface ZohoUserAddressInput {
  line1?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  country?: string;
}

/**
 * User shape consumed by createContact / updateContactDetails / recurring.
 *
 * Declared as a wide-but-named structural type rather than `any` so the
 * Zoho integration documents which user fields it actually reads, while
 * still accepting Mongoose-hydrated `IUser` documents (which carry many
 * extra fields + methods that wouldn't fit a strict `[k: string]: unknown`
 * index signature). The integration only touches these named fields —
 * callers needn't trim their User docs to match.
 */
export type ZohoUserInput = {
  _id?: unknown;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  companyName?: string;
  gstNumber?: string;
  address?: ZohoUserAddressInput;
};

/** Cart-item / order-line shape consumed by createInvoice / createRecurring. */
export interface ZohoOrderItemInput {
  itemType?: "domain" | "hosting" | (string & {});
  domainName?: string;
  linkedDomain?: string;
  price?: number;
  registrationPeriod?: number;
  periodUnit?: "minutes" | "months" | "years" | "days" | (string & {});
  hostingPlan?: {
    name?: string;
    planId?: string;
    serverPackage?: string;
    features?: string[];
  };
  [k: string]: unknown;
}

/** Order shape consumed by createInvoice / createRecurring. */
export interface ZohoOrderInput {
  orderId?: string;
  reference_number?: string;
  razorpayPaymentId?: string;
  paymentId?: string;
  total?: number;
  amount?: number;
  createdAt?: string | number | Date;
  [k: string]: unknown;
}

// ─── Catch-block helper ───────────────────────────────────────────────────────

/**
 * Pull a useful error payload out of an unknown error in a Zoho catch
 * block. Returns `{ data: { code, message }, message }` shape callers
 * already expect — avoids `(error as any).response?.data` patterns.
 */
export function unwrapZohoError(err: unknown): {
  data?: { code?: number; message?: string; [k: string]: unknown };
  status?: number;
  message: string;
} {
  if (err instanceof AxiosError) {
    return {
      data: err.response?.data as
        | { code?: number; message?: string; [k: string]: unknown }
        | undefined,
      status: err.response?.status,
      message: err.message,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}
