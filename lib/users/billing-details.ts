/**
 * A customer's billing details — the ONE place the portal reads and updates them (10 Oct 2026,
 * Pawan: "only users who have bought our service are inside the customer panel, their details
 * should be reused … with an option to repair them").
 *
 * Two writers, two rules:
 *   - an order from ResellerOS (customer.ensure) only FILLS what is empty — it never overwrites
 *     what the customer set themselves;
 *   - the customer saving at checkout ("Save for next time") REPLACES them — they asked to.
 *
 * Every product the portal sells (hosting, domains, and later email and SSL) reuses this block.
 */
import { normaliseIndianState } from "@/lib/constants";

export interface BillingDetails {
  companyName?: string;
  gstin?: string;
  /** The buyer's state — decides CGST+SGST or IGST. Also the address's state when there is one. */
  state?: string;
  address?: { line1: string; city: string; zipcode: string; country?: string };
}

const GSTIN = /^[0-9A-Z]{15}$/;
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Billing details from any untrusted source, with anything malformed dropped (never guessed). */
export function parseBillingDetails(raw: unknown): BillingDetails {
  const r = (raw ?? {}) as Record<string, unknown>;
  const a = (r.address ?? {}) as Record<string, unknown>;
  const out: BillingDetails = {};
  const company = clean(r.companyName, 200);
  if (company.length >= 2) out.companyName = company;
  const gstin = clean(r.gstin, 20).toUpperCase();
  if (GSTIN.test(gstin)) out.gstin = gstin;
  const state = normaliseIndianState(clean(r.state, 80) || clean(a.state, 80));
  if (state) out.state = state;
  const line1 = clean(a.line1, 200), city = clean(a.city, 100), zipcode = clean(a.zipcode, 12);
  if (line1 && city && zipcode.length >= 3) out.address = { line1, city, zipcode, country: clean(a.country, 2).toUpperCase() || "IN" };
  return out;
}

/** The fields of a user document this module touches. */
export interface BillingUser {
  companyName?: string;
  gstNumber?: string;
  address?: { line1?: string; city?: string; state?: string; zipcode?: string; country?: string };
}

/**
 * Apply details to a user, in place. `mode: "fill"` sets only empty fields; `"replace"` sets every
 * field given. Returns the field names that changed (empty → nothing to save).
 */
export function mergeBillingDetails(user: BillingUser, d: BillingDetails, mode: "fill" | "replace"): string[] {
  const changed: string[] = [];
  const set = (current: string | undefined, next: string | undefined): boolean =>
    !!next && next !== current && (mode === "replace" || !current);
  if (set(user.companyName, d.companyName)) { user.companyName = d.companyName; changed.push("companyName"); }
  if (set(user.gstNumber, d.gstin)) { user.gstNumber = d.gstin; changed.push("gstin"); }
  const addr = { ...(user.address ?? {}) };
  if (d.address) {
    const hasAddress = !!(addr.line1 && addr.city && addr.zipcode);
    if (mode === "replace" || !hasAddress) {
      Object.assign(addr, { line1: d.address.line1, city: d.address.city, zipcode: d.address.zipcode, country: d.address.country || "IN" });
      changed.push("address");
    }
  }
  if (set(addr.state, d.state)) { addr.state = d.state; changed.push("state"); }
  if (changed.some((c) => c === "address" || c === "state")) user.address = addr;
  return changed;
}

/** Billing details as the checkout shows them, from a user. */
export function billingDetailsOf(user: BillingUser): BillingDetails & { complete: { forHosting: boolean; forDomain: boolean } } {
  const a = user.address ?? {};
  const out: BillingDetails = {
    ...(user.companyName ? { companyName: user.companyName } : {}),
    ...(user.gstNumber ? { gstin: user.gstNumber } : {}),
    ...(a.state ? { state: a.state } : {}),
    ...(a.line1 && a.city && a.zipcode ? { address: { line1: a.line1, city: a.city, zipcode: a.zipcode, country: a.country || "IN" } } : {}),
  };
  const hasState = !!normaliseIndianState(out.state ?? "");
  return { ...out, complete: { forHosting: hasState, forDomain: hasState && !!out.address } };
}
