/**
 * Centralized Hosting Date Management
 * 
 * This utility ensures consistent date handling across all hosting creation flows.
 * Registration date is set to the exact moment of creation, and expiry is calculated
 * as exactly N months later using setMonth to avoid year-based bugs.
 */

/**
 * Calculate hosting registration and expiry dates
 * @param registrationPeriod - Number of units for the hosting period
 * @param unit - Unit of time ('months' | 'minutes') - defaults to 'months'
 * @returns Object with registeredAt and expiresAt dates
 */
import { getCurrentDate } from "@/lib/dateUtils";

/**
 * Calculate hosting registration and expiry dates
 * @param registrationPeriod - Number of units for the hosting period
 * @param unit - Unit of time ('months' | 'days' | 'minutes') - defaults to 'months'
 * @returns Object with registeredAt and expiresAt dates
 */
export function calculateHostingDates(registrationPeriod: number, unit: 'months' | 'days' | 'minutes' = 'months') {
  const now = getCurrentDate();
  
  // Use the exact current time for registration
  const registeredAt = now;
  
  const expiresAt = new Date(registeredAt);
  
  if (unit === 'days') {
    expiresAt.setDate(expiresAt.getDate() + registrationPeriod);
  } else if (unit === 'minutes') {
    expiresAt.setMinutes(expiresAt.getMinutes() + registrationPeriod);
  } else {
    // Default to monthly calculation
    expiresAt.setMonth(expiresAt.getMonth() + registrationPeriod);
  }
  
  return {
    registeredAt: registeredAt,
    expiresAt: expiresAt
  };
}

/**
 * Validate registration period
 * @param period - Registration period to validate
 * @returns Validated period (defaults to 1 if invalid)
 */
export function validateRegistrationPeriod(period: number | undefined): number {
  if (period === 12) return 12;
  return 1; // Default to 1 month
}
