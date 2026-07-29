/**
 * Shared guard for "does this hosting item have a real, provisionable domain?".
 *
 * Born 2026-07-29 (dms-00441) after a guest paid-hosting order completed +
 * invoiced but then hard-failed DirectAdmin provisioning with "Cannot Create
 * Account - Invalid Domain Name" — the hosting item carried the synthetic
 * placeholder `hosting-<planId>-<Date.now()>` (see
 * components/marketing/HostingLanding.tsx) instead of a real linked domain, so
 * the customer was charged for hosting that could never be created.
 *
 * Used by BOTH create-order routes (logged-in + guest) to reject such an order
 * up front with 400 HOSTING_DOMAIN_REQUIRED, so payment is never taken for a
 * hosting plan that DA can't provision.
 *
 * Why a real regex and not `startsWith("hosting-") || !includes(".")`:
 *   - `startsWith("hosting-")` false-rejects legitimately-registrable domains
 *     like `hosting-guru.com` — real domains DO start with "hosting-".
 *   - `includes(".")` false-accepts malformed junk like `.com`, `a.`, `x. y`
 *     which DA would still reject → re-opens the charge-then-fail hole.
 * A proper hostname regex inherently rejects the dot-less placeholder AND
 * malformed strings, while accepting real `hosting-*.com` domains and IDN
 * punycode (`xn--…`) labels/TLDs.
 */

// Each label: 1–63 chars, alphanumeric with internal hyphens (covers punycode
// `xn--…`). TLD: 2+ letters OR a punycode `xn--…` IDN TLD. Total length ≤ 253.
const PROVISIONABLE_DOMAIN_RE =
  /^(?=.{4,253}$)(?!-)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,}|xn--[a-z0-9-]+)$/;

/**
 * True only for a syntactically valid, provisionable domain name. Trims +
 * lowercases first so callers don't have to. Rejects empty/whitespace, the
 * `hosting-<plan>-<ts>` placeholder (no dot), and any malformed hostname.
 */
export function isProvisionableDomain(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const dom = value.trim().toLowerCase();
  if (!dom) return false;
  return PROVISIONABLE_DOMAIN_RE.test(dom);
}

/** Resolve the effective domain for a hosting cart item (linked wins). */
export function hostingItemDomain(item: {
  linkedDomain?: unknown;
  domainName?: unknown;
}): string {
  const linked = typeof item.linkedDomain === "string" ? item.linkedDomain : "";
  const name = typeof item.domainName === "string" ? item.domainName : "";
  return (linked || name || "").trim().toLowerCase();
}

export const HOSTING_DOMAIN_REQUIRED_MESSAGE =
  "Please connect a domain to your hosting plan before checking out. Link a domain you already own, or register a new one — hosting can't be set up without a domain.";
