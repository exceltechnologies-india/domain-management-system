/**
 * Live price verification used at payment-creation time.
 *
 * The customer-facing pricing endpoint (`/api/domains/pricing`) is cached
 * for display, but cached prices are NEVER used to charge the customer.
 * Before creating a Razorpay order, this module fetches LIVE pricing from
 * ResellerClub, recomputes the total server-side, and verifies the client-
 * claimed total matches. If they differ, the order is rejected so the
 * customer can refresh and see the current price.
 *
 * Hosting items are not verified here — hosting prices come from the local
 * `HostingPlan` model, not from RC. Those routes have their own server-
 * computed amounts.
 */

import { ResellerClubAPI } from "@/lib/resellerclub";
import { serverLogger } from "@/lib/server-logger";
import { tldMappings } from "@/lib/tld-mappings";

interface DomainCartItem {
  domainName: string;
  price: number;
  currency?: string;
  registrationPeriod?: number;
  itemType?: "domain" | "hosting";
}

export interface VerifyResult {
  ok: boolean;
  /** Server-computed total in INR (verified). */
  serverTotal: number;
  /** Client-supplied total in INR. */
  clientTotal: number;
  /** Per-domain live customer prices keyed by domainName. */
  livePrices: Record<string, number>;
  /** If !ok, a human-friendly reason. */
  error?: string;
  /** Domains whose live price differs from the client's price. */
  mismatchedDomains: string[];
  /** True when we couldn't fetch live pricing and fell back to client total. */
  fellBackToClient: boolean;
}

/**
 * Tolerance window in rupees. Rounding differences shouldn't fail a payment.
 * We accept up to ₹1 absolute or 0.5% relative drift, whichever is larger.
 */
const ABS_TOLERANCE = 1;
const REL_TOLERANCE = 0.005;

/**
 * Extract the TLD from a domain name and convert it to the RC API key format.
 *
 * ResellerClub uses inconsistent prefixes per TLD (`dotcom` is wrong — `.com`
 * is keyed as `domcno`). The `tldMappings` table is the authoritative source.
 * Falls back to a heuristic for TLDs not in the table.
 *
 * Examples:
 *   "example.com"   → "domcno"   (from mapping)
 *   "shop.co.in"    → "thirdleveldotin" → falls back via heuristic
 *   "site.dev"      → "dotdev"   (from mapping)
 *   "foo.xyz"       → "dotxyz"   (heuristic — not in mapping but follows convention)
 */
function domainToRcKey(domainName: string): string | null {
  const parts = domainName.toLowerCase().trim().split(".");
  if (parts.length < 2) return null;
  // Prefer multi-level TLD if it's a known one
  if (parts.length >= 3) {
    const twoLevel = parts.slice(-2).join(".");
    if (tldMappings[twoLevel]) return tldMappings[twoLevel];
    // Heuristic for co.* style
    const second = parts[parts.length - 2];
    if (second === "co") return `codot${parts[parts.length - 1]}`;
  }
  const tld = parts[parts.length - 1];
  // Authoritative mapping wins
  if (tldMappings[tld]) return tldMappings[tld];
  // Fallback heuristic for new gTLDs that follow the `dot${name}` convention
  return `dot${tld}`;
}

/**
 * Parse the per-year customer price for one TLD from RC's pricing payload.
 *
 * RC structures `addnewdomain` as a map keyed by year buckets ("1" .. "10"),
 * each holding the per-year price. For most TLDs every bucket has the same
 * value. For min-period TLDs like .ai, only some buckets are populated —
 * we try the requested year first, fall back to any available year.
 */
function extractCustomerPrice(customerData: any, years: number = 1): number {
  if (!customerData) return 0;
  if (typeof customerData !== "object") {
    const n = parseFloat(String(customerData));
    return isNaN(n) ? 0 : n;
  }
  const addnew = customerData.addnewdomain;
  if (addnew && typeof addnew === "object") {
    // Requested year takes precedence
    const target = addnew[String(years)];
    if (target !== undefined && target !== null) {
      const n = parseFloat(String(target));
      if (!isNaN(n) && n > 0) return n;
    }
    // Fall back to any available year bucket (per-year price is usually uniform)
    for (const k of Object.keys(addnew)) {
      const n = parseFloat(String(addnew[k]));
      if (!isNaN(n) && n > 0) return n;
    }
  }
  // Legacy / alternative shapes
  const raw =
    customerData[String(years)] ??
    customerData["1"] ??
    customerData.price ??
    "0";
  const n = parseFloat(String(raw));
  return isNaN(n) ? 0 : n;
}

/**
 * Verify that the client-supplied prices match live ResellerClub pricing.
 *
 * Strategy:
 *   1. Filter to domain items only (hosting handled elsewhere).
 *   2. Call RC live (never cache) to get current customer pricing.
 *   3. For each domain item, look up its TLD's live customer price.
 *   4. Sum livePrice × registrationPeriod for the server-computed total.
 *   5. Compare against client total within rounding tolerance.
 *
 * If the RC live fetch fails, we log the error and fall back to the client
 * total — refusing payment on a transient RC outage would be worse than
 * accepting the (cached-validated) client price.
 */
export async function verifyDomainPrices(
  cartItems: DomainCartItem[]
): Promise<VerifyResult> {
  const domainItems = cartItems.filter(
    (i) => !i.itemType || i.itemType === "domain"
  );

  const clientTotal = domainItems.reduce(
    (sum, i) => sum + (i.price || 0) * (i.registrationPeriod || 1),
    0
  );

  // No domain items → nothing to verify (e.g. hosting-only order).
  if (domainItems.length === 0) {
    return {
      ok: true,
      serverTotal: clientTotal,
      clientTotal,
      livePrices: {},
      mismatchedDomains: [],
      fellBackToClient: false,
    };
  }

  let livePricing: any;
  try {
    livePricing = await ResellerClubAPI.getDomainPricing();
  } catch (err) {
    // Live fetch failed — log but accept the client price so RC outage
    // doesn't kill every checkout.
    serverLogger.error(
      "[price-verifier] Failed to fetch live RC pricing — accepting client total",
      err
    );
    return {
      ok: true,
      serverTotal: clientTotal,
      clientTotal,
      livePrices: {},
      mismatchedDomains: [],
      fellBackToClient: true,
    };
  }

  const customerPricing = livePricing?.customerPricing;
  if (!customerPricing || typeof customerPricing !== "object") {
    serverLogger.error(
      "[price-verifier] RC returned malformed pricing data — accepting client total"
    );
    return {
      ok: true,
      serverTotal: clientTotal,
      clientTotal,
      livePrices: {},
      mismatchedDomains: [],
      fellBackToClient: true,
    };
  }

  const livePrices: Record<string, number> = {};
  const mismatchedDomains: string[] = [];
  const unverifiableDomains: string[] = [];
  let serverTotal = 0;

  for (const item of domainItems) {
    const yrs = item.registrationPeriod || 1;
    const clientPrice = item.price || 0;
    const rcKey = domainToRcKey(item.domainName);
    const live = rcKey ? extractCustomerPrice(customerPricing[rcKey], yrs) : 0;

    if (!live) {
      // RC has data but no price for this specific TLD. We refuse to charge
      // a price we can't verify — this is the attacker-bypass surface we
      // explicitly want closed. Conservative: reject.
      unverifiableDomains.push(item.domainName);
      livePrices[item.domainName] = 0;
      continue;
    }

    livePrices[item.domainName] = live;

    // Per-domain mismatch check
    const diff = Math.abs(live - clientPrice);
    const tol = Math.max(ABS_TOLERANCE, clientPrice * REL_TOLERANCE);
    if (diff > tol) {
      mismatchedDomains.push(item.domainName);
    }
    serverTotal += live * yrs;
  }

  if (unverifiableDomains.length > 0) {
    serverLogger.warn(
      `[price-verifier] Could not find live RC price for: ${unverifiableDomains.join(", ")}`
    );
    return {
      ok: false,
      serverTotal,
      clientTotal,
      livePrices,
      mismatchedDomains: unverifiableDomains,
      fellBackToClient: false,
      error: `We couldn't verify the live price for ${unverifiableDomains.slice(0, 2).join(", ")}${unverifiableDomains.length > 2 ? "…" : ""}. Please contact support.`,
    };
  }

  // Final total comparison (catches accumulated rounding mismatches too)
  const totalDiff = Math.abs(serverTotal - clientTotal);
  const totalTol = Math.max(ABS_TOLERANCE, clientTotal * REL_TOLERANCE);
  const totalsAgree = totalDiff <= totalTol;

  if (mismatchedDomains.length === 0 && totalsAgree) {
    return {
      ok: true,
      serverTotal,
      clientTotal,
      livePrices,
      mismatchedDomains: [],
      fellBackToClient: false,
    };
  }

  // Build a friendly error message that names the changed TLDs.
  const changedList = mismatchedDomains.length > 0
    ? mismatchedDomains.slice(0, 3).join(", ") + (mismatchedDomains.length > 3 ? "…" : "")
    : `total ₹${clientTotal.toFixed(2)} vs ₹${serverTotal.toFixed(2)}`;
  return {
    ok: false,
    serverTotal,
    clientTotal,
    livePrices,
    mismatchedDomains,
    fellBackToClient: false,
    error: `Prices have updated. Please refresh your cart — ${changedList} changed.`,
  };
}
