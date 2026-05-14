import { format } from "date-fns";

/**
 * Service Accounting Code for Domain and Hosting Services in India.
 */
export const SAC_CODE = "998319";

/**
 * Calculates the subscription end date based on duration and unit.
 */
export function calculateSubscriptionEndDate(startDate: Date, duration: number, unit: "years" | "months" | "days" | "minutes" = "years"): Date {
  const endDate = new Date(startDate);
  if (unit === "years") {
    endDate.setFullYear(startDate.getFullYear() + duration);
  } else if (unit === "months") {
    endDate.setMonth(startDate.getMonth() + duration);
  } else if (unit === "days") {
    endDate.setDate(startDate.getDate() + duration);
  } else {
    // For minutes (less common for domains), just add them
    endDate.setMinutes(startDate.getMinutes() + duration);
  }
  // Subtract 1 day off the end to be exactly 1 year/month (e.g., 01/01 to 31/12)
  // For 'days', we might not want to subtract 1 day if it's a very short period (like 1-day hosting)
  if (unit !== "days" || duration > 1) {
    endDate.setDate(endDate.getDate() - 1);
  }
  return endDate;
}

/**
 * Formats the subscription period for display on invoices.
 * Example: 1 Year (14/10/2024 - 13/10/2025)
 */
export function formatSubscriptionPeriod(startDate: Date, duration: number, unit: "years" | "months" | "days" | "minutes" = "years"): string {
  const endDate = calculateSubscriptionEndDate(startDate, duration, unit);
  let durationText = "";
  
  if (unit === "years") {
    durationText = `${duration} Year${duration !== 1 ? "s" : ""}`;
  } else if (unit === "months") {
    durationText = `${duration} Month${duration !== 1 ? "s" : ""}`;
  } else if (unit === "days") {
    durationText = `${duration} Day${duration !== 1 ? "s" : ""}`;
  } else {
    durationText = `${duration} Minute${duration !== 1 ? "s" : ""}`;
  }
  
  return `${durationText} (${format(startDate, "dd/MM/yyyy")} - ${format(endDate, "dd/MM/yyyy")})`;
}

/**
 * Format quantity with unit for invoices.
 */
export function formatQuantityText(quantity: number, unit: "years" | "months" | "days" | "minutes" = "years", itemType: "domain" | "hosting" = "domain"): string {
  if (itemType === "domain") {
    return `${quantity.toFixed(2)}\nYear/s`;
  }
  if (unit === "days") {
    return `${quantity.toFixed(2)}\nDay/s`;
  }
  return `${quantity.toFixed(2)}\nMonth/s`;
}
