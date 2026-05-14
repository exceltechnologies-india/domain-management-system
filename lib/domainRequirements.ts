// Domain requirements data for different TLDs
import { TLD_POLICIES } from "./tld-policies";

export interface DomainRequirement {
  text: string;
  required: boolean;
}

export interface DomainRestriction {
  text: string;
  type: "warning" | "error" | "info";
}

export interface AlternativeDomain {
  domain: string;
  available: boolean;
  price?: string;
}

// TLDs that require special permissions and should be blocked from cart.
// Derived from the central registry — restricted = local presence required.
export const RESTRICTED_TLDS: string[] = Object.entries(TLD_POLICIES)
  .filter(([, p]) => p.restricted === true)
  .map(([tld]) => `.${tld}`);

/**
 * Check if a specific TLD is restricted for registration
 * @param tld The TLD to check (e.g., ".com" or "com")
 */
export function isRestrictedTLD(tld: string): boolean {
  const normalized = tld.startsWith(".") ? tld.slice(1) : tld;
  return TLD_POLICIES[normalized.toLowerCase()]?.restricted === true;
}

// Pre-defined requirements for common TLDs
export const DOMAIN_REQUIREMENTS: Record<
  string,
  {
    requirements: DomainRequirement[];
    restrictions: DomainRestriction[];
  }
> = {
  ".au": {
    requirements: [
      {
        text: "Australian Business Number (ABN) or Australian Company Number (ACN)",
        required: true,
      },
      { text: "Australian presence or connection", required: true },
      { text: "Business registration details", required: true },
      { text: "Specific contact information requirements", required: true },
    ],
    restrictions: [
      { text: "Must have Australian business registration", type: "warning" },
      {
        text: "Cannot be registered by individuals without business connection",
        type: "error",
      },
      { text: "Requires additional verification process", type: "info" },
    ],
  },
  ".co.uk": {
    requirements: [
      { text: "UK presence or connection", required: true },
      { text: "Valid UK address", required: true },
      { text: "Contact information in UK", required: true },
    ],
    restrictions: [
      { text: "Must have UK connection", type: "warning" },
      { text: "Cannot be registered without UK presence", type: "error" },
    ],
  },
  ".ca": {
    requirements: [
      { text: "Canadian presence or connection", required: true },
      { text: "Valid Canadian address", required: true },
      { text: "Canadian citizen or permanent resident", required: true },
    ],
    restrictions: [
      { text: "Must have Canadian connection", type: "warning" },
      { text: "Cannot be registered without Canadian presence", type: "error" },
    ],
  },
  ".de": {
    requirements: [
      { text: "German presence or connection", required: true },
      { text: "Valid German address", required: true },
      { text: "German citizen or resident", required: true },
    ],
    restrictions: [
      { text: "Must have German connection", type: "warning" },
      { text: "Cannot be registered without German presence", type: "error" },
    ],
  },
};

// Function to get requirements for a specific TLD
export function getDomainRequirements(tld: string): {
  requirements: DomainRequirement[];
  restrictions: DomainRestriction[];
} {
  return (
    DOMAIN_REQUIREMENTS[tld] || {
      requirements: [],
      restrictions: [],
    }
  );
}

// Function to generate alternative domains
export function generateAlternativeDomains(
  domainName: string,
  tld: string
): AlternativeDomain[] {
  const alternatives: AlternativeDomain[] = [];
  const commonTlds = [".com", ".net", ".org", ".io", ".co"];

  commonTlds.forEach((altTld) => {
    if (altTld !== tld) {
      alternatives.push({
        domain: `${domainName}${altTld}`,
        available: true, // This would be checked against actual availability
        price: getTldPrice(altTld),
      });
    }
  });

  return alternatives;
}

// Function to get pricing for TLDs
function getTldPrice(tld: string): string {
  const prices: Record<string, string> = {
    ".com": "$12.99/year",
    ".net": "$14.99/year",
    ".org": "$13.99/year",
    ".io": "$49.99/year",
    ".co": "$29.99/year",
  };

  return prices[tld] || "$12.99/year";
}

// Function to check if a TLD requires special verification
export function requiresSpecialVerification(tld: string): boolean {
  return Object.keys(DOMAIN_REQUIREMENTS).includes(tld);
}

// Alias for backward compatibility
export const requiresAdditionalDetails = requiresSpecialVerification;
export const isDomainSupported = (tld: string): boolean =>
  !requiresSpecialVerification(tld);
