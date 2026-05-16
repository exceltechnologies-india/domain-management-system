/**
 * Shared types for ResellerClub API responses.
 *
 * ResellerClub returns map-shaped JSON keyed by either TLD ("com", "in",
 * "co.uk") or full domain name ("example.com"). The values are themselves
 * small records with overlapping but never-quite-identical shapes — pricing
 * looks like `{ addnewdomain: { "1": "300", "2": "550" } }`, availability
 * looks like `{ status: "available", classkey: "domcno" }`.
 *
 * These types capture what we actually use, not the full theoretical shape
 * — the upstream API has historically added new fields without versioning,
 * so we keep the records open via index signatures rather than `Required<>`.
 */

/**
 * Per-TLD pricing block. Periods are stringified integers ("1", "2", …).
 * Prices are string-encoded floats — callers must `parseFloat()`.
 */
export interface RcTldPricing {
  addnewdomain?: { [period: string]: string };
  renewdomain?: { [period: string]: string };
  restoredomain?: { [period: string]: string };
  transferdomain?: { [period: string]: string };
  /** Open index for fields the API has added since this type was written. */
  [k: string]: unknown;
}

/**
 * Response from `/api/products/customer-price.json` and
 * `/api/products/reseller-price.json` — a flat map of TLD → pricing block.
 */
export type RcPricingResponse = { [tld: string]: RcTldPricing };

/**
 * Combined pricing returned by `getDomainPricing()` — both customer and
 * reseller maps with a fetch timestamp.
 */
export interface RcDomainPricing {
  customerPricing: RcPricingResponse;
  resellerPricing: RcPricingResponse;
  timestamp: string;
}

/**
 * Per-TLD record returned by `getTLDPricing()` — pairs the upstream
 * customer/reseller pricing blocks and echoes the TLD name for callers
 * that iterate the map. `reseller` may be null when the upstream lookup
 * couldn't find a matching reseller entry.
 */
export interface RcTldPricingPair {
  customer: RcTldPricing;
  reseller: RcTldPricing | null;
  tld: string;
}

/**
 * Extended per-TLD record returned by `PricingService.getTLDPricing` —
 * the same pair plus pre-extracted scalar values that the downstream UI
 * uses without re-parsing the raw blocks. `price` and `resellerPrice` are
 * stringified by ResellerClub but the helper returns them as numbers.
 */
export interface RcTldPricingDetail extends RcTldPricingPair {
  price: number;
  resellerPrice: number;
  currency: string;
  registrationPeriod: number;
}

/**
 * Per-domain availability entry from `/api/domains/available.json`.
 * Known status values are listed for autocomplete; the type stays open
 * because ResellerClub occasionally returns new ones.
 */
export interface RcAvailabilityEntry {
  status:
    | "available"
    | "regthroughothers"
    | "regthroughresellerclub"
    | "unknown"
    | "error"
    | (string & {});
  classkey?: string;
  message?: string;
  [k: string]: unknown;
}

/**
 * Response from `/api/domains/available.json` — a map of domain → entry.
 * The keys carry both the base name and the full TLD (e.g. `"example.com"`).
 */
export type RcAvailabilityResponse = { [domain: string]: RcAvailabilityEntry };

/**
 * Query params shape for the availability endpoint. `tlds` accepts a
 * comma-separated string of TLDs (without leading dot).
 */
export interface RcAvailabilitySearchParams {
  "domain-name": string;
  tlds?: string;
}

/**
 * Raw DNS record as returned by `/api/dns/manage/search-records.json`.
 *
 * Field names are inconsistent across record types — `recordid` for some,
 * `record-id` for others; `timetolive` vs `ttl`; `host` vs `name`. Callers
 * normalise this into a single shape, so the type is intentionally open
 * around the known-key island.
 */
export interface RcDnsRecord {
  type?: string;
  value?: string;
  recordid?: string;
  recordId?: string;
  "record-id"?: string;
  timetolive?: string | number;
  ttl?: string | number;
  host?: string;
  name?: string;
  priority?: string | number;
  [k: string]: unknown;
}
