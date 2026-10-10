/**
 * What the Customer Portal sells, and what each product needs at checkout — declared once.
 *
 * Pawan, 10 Oct 2026: "in future we will add more products to DMS like Business Emails from
 * Google Workspace, Microsoft email and Zoho Emails … also the SSL and security ones could be
 * separately sold". A new product is a new entry here plus its ResellerOS SKU — the checkout reads
 * `needs` instead of growing a branch per product, and the billing details block (lib/users/
 * billing-details.ts) is shared by all of them.
 */

export type ProductKind = 'hosting' | 'domain' | 'email' | 'ssl';

export interface ProductNeeds {
  /** The website/domain the service runs on (hosting, email, SSL), typed by the customer. */
  siteDomain: boolean;
  /** A registrant's postal address — a domain registration (or a hosting order that registers one). */
  registrantAddress: boolean;
  /** How the term is chosen: a monthly/yearly cycle, a number of years, or seats per month. */
  term: 'cycle' | 'years' | 'seats';
}

export interface PanelProduct {
  kind: ProductKind;
  label: string;
  /** Sold in the portal today. `false` = planned: listed here so the design already fits it. */
  available: boolean;
  needs: ProductNeeds;
}

export const PANEL_PRODUCTS: Record<ProductKind, PanelProduct> = {
  hosting: { kind: 'hosting', label: 'Web hosting', available: true, needs: { siteDomain: true, registrantAddress: false, term: 'cycle' } },
  domain: { kind: 'domain', label: 'Domains', available: true, needs: { siteDomain: false, registrantAddress: true, term: 'years' } },
  // Planned (Google Workspace, Microsoft 365, Zoho Mail): seats on the customer's domain.
  email: { kind: 'email', label: 'Business email', available: false, needs: { siteDomain: true, registrantAddress: false, term: 'seats' } },
  // Planned: certificates sold on their own, for a domain hosted anywhere.
  ssl: { kind: 'ssl', label: 'SSL & security', available: false, needs: { siteDomain: true, registrantAddress: false, term: 'years' } },
};

/**
 * What one checkout must collect: the product's own needs, plus a registrant address when a
 * hosting order also registers its domain ("Register it in this order").
 */
export function checkoutNeeds(kind: ProductKind, opts: { registerDomain?: boolean } = {}): ProductNeeds {
  const base = PANEL_PRODUCTS[kind].needs;
  return { ...base, registrantAddress: base.registrantAddress || opts.registerDomain === true };
}
