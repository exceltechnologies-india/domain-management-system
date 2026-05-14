import { CartItem } from "./types";

export type ItemType = 'domain' | 'hosting';

export interface ExpirationResult {
  expiresAt: Date;
  itemType: ItemType;
  periodUnit: 'year' | 'month' | 'days';
  duration: number;
}

/**
 * Strictly checks if a cart item is a hosting subscription.
 * Prioritizes itemType if present. 
 * Fallback detection requires substantive hosting data or a placeholder domain name.
 */
export function isHostingItem(item: CartItem): boolean {
  // Explicitly defined type takes priority
  if (item.itemType === 'hosting') return true;
  
  // Fallback Detection: Check for substantive hosting data or a placeholder domain name
  // We check this BEFORE the domain-type check to catch mislabeled trial items
  const hasHostingData = !!(item.hostingPlan && (item.hostingPlan.name || item.hostingPlan.serverPackage));
  const isPlaceholder = !!(item.domainName && item.domainName.startsWith('hosting-'));
  
  if (hasHostingData || isPlaceholder) return true;
  if (item.itemType === 'domain') return false;

  return false;
}

/**
 * Strictly checks if a cart item is a domain registration.
 * Uses inverse logic of isHostingItem for consistency.
 */
export function isDomainItem(item: CartItem): boolean {
  // Explicitly defined type takes priority
  if (item.itemType === 'domain') return true;
  if (item.itemType === 'hosting') return false;
  
  // Fallback: If not hosting, assume domain
  return !isHostingItem(item);
}

/**
 * Centralized logic to calculate expiration dates.
 * ELIMINATES AMBIGUITY by enforcing strict priority.
 */
export function calculateItemExpiration(item: CartItem): ExpirationResult {
  const duration = item.registrationPeriod || 1;
  const now = new Date();
  
  // SAFETY CHECK: Domain registrations cannot exceed 10 years.
  // If duration > 10, it MUST be a month-based service (hosting),
  // regardless of what check says. This fixes the 2038 bug (12 months != 12 years).
  const forceMonthly = duration > 10;

  // HOSTING takes priority (Month-based)
  if (isHostingItem(item) || forceMonthly) {
    const expiresAt = new Date(now);
    const unit = item.periodUnit || 'months';

    if (unit === 'days') {
      expiresAt.setDate(expiresAt.getDate() + duration);
    } else {
      expiresAt.setMonth(expiresAt.getMonth() + duration);
    }

    return {
      expiresAt,
      itemType: 'hosting',
      periodUnit: unit === 'days' ? 'days' : 'month',
      duration
    };
  }
  
  // DOMAIN is default (Year-based)
  if (isDomainItem(item)) {
    const expiresAt = new Date(now);
    expiresAt.setFullYear(expiresAt.getFullYear() + duration);
    return {
      expiresAt,
      itemType: 'domain',
      periodUnit: 'year',
      duration
    };
  }

  // Should be unreachable given `isDomainItem` fallback, but good for validation
  throw new Error(`Unknown item type for item: ${JSON.stringify(item)}`);
}

/**
 * Validates that an item has necessary fields for its type
 */
export function validateCartItem(item: CartItem): string | null {
  if (isHostingItem(item)) {
    if (!item.hostingPlan) return `Hosting item matches type but missing 'hostingPlan' details`;
  }
  if (!item.domainName) return 'Missing domain name';
  if (!item.price) return 'Missing price';
  return null;
}
