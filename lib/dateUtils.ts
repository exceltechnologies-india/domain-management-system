/**
 * Date utility functions for Indian timezone (IST)
 * All dates and times in the application should use these functions
 */

// Indian timezone options
const INDIAN_TIMEZONE = "Asia/Kolkata";
const INDIAN_LOCALE = "en-IN";

/**
 * Format a date to Indian date format (DD/MM/YYYY)
 */
export function formatIndianDate(date: string | Date | null | undefined): string {
  if (!date) return "-";

  const dateObj = typeof date === "string" ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return "-";
  }

  return dateObj.toLocaleDateString(INDIAN_LOCALE, {
    timeZone: INDIAN_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Format a date to Indian date and time format (DD/MM/YYYY, HH:MM AM/PM)
 */
export function formatIndianDateTime(date: string | Date | null | undefined): string {
  if (!date) return "-";

  const dateObj = typeof date === "string" ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return "-";
  }

  return dateObj.toLocaleString(INDIAN_LOCALE, {
    timeZone: INDIAN_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Format a date to Indian time format (HH:MM AM/PM)
 */
export function formatIndianTime(date: string | Date | null | undefined): string {
  if (!date) return "-";

  const dateObj = typeof date === "string" ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return "-";
  }

  return dateObj.toLocaleTimeString(INDIAN_LOCALE, {
    timeZone: INDIAN_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Format a date to Indian long date format (DD Month YYYY)
 */
export function formatIndianLongDate(date: string | Date | null | undefined): string {
  if (!date) return "-";

  const dateObj = typeof date === "string" ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return "-";
  }

  return dateObj.toLocaleDateString(INDIAN_LOCALE, {
    timeZone: INDIAN_TIMEZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Format a date to Indian long date and time format (DD Month YYYY, HH:MM AM/PM)
 */
export function formatIndianLongDateTime(date: string | Date | null | undefined): string {
  if (!date) return "-";

  const dateObj = typeof date === "string" ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return "-";
  }

  return dateObj.toLocaleString(INDIAN_LOCALE, {
    timeZone: INDIAN_TIMEZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Get current date in Indian timezone
 */
export function getCurrentIndianDate(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: INDIAN_TIMEZONE })
  );
}

/**
 * Format currency in Indian format (₹1,23,456.78)
 */
export function formatIndianCurrency(amount: number): string {
  return new Intl.NumberFormat(INDIAN_LOCALE, {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format number in Indian format (1,23,456)
 */
export function formatIndianNumber(number: number): string {
  return new Intl.NumberFormat(INDIAN_LOCALE).format(number);
}

/**
 * Get relative time string (e.g., "2 days ago", "In 5 months")
 */
export function getRelativeTime(date: string | Date | null | undefined): string {
  if (!date) return "";
  
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";

  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const absDiff = Math.abs(diff);
  const days = Math.floor(absDiff / (1000 * 60 * 60 * 24));
  
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (Math.abs(diff) < 1000 * 60 * 60) {
      // Less than an hour
      const minutes = Math.round(diff / (1000 * 60));
      return formatter.format(minutes, 'minute');
  }

  if (Math.abs(diff) < 1000 * 60 * 60 * 24) {
      // Less than a day
      const hours = Math.round(diff / (1000 * 60 * 60));
      return formatter.format(hours, 'hour');
  }

  if (days < 30) {
      return formatter.format(diff > 0 ? days : -days, 'day');
  }
  
  const months = Math.round(days / 30.44); // Average days in month
  if (months < 12) {
      return formatter.format(diff > 0 ? months : -months, 'month');
  }
  
  const years = Math.round(days / 365.25);
  return formatter.format(diff > 0 ? years : -years, 'year');
}

/**
 * Get current date (UTC)
 * Use this for all DB storage and logic comparisons
 */
export function getCurrentDate(): Date {
  return new Date();
}

/**
 * Format a date to Indian date format (DD/MM/YYYY)
 * Alias for formatIndianDate
 */
export const formatDateIN = formatIndianDate;

/**
 * Format a date to Indian date and time format with seconds (DD/MM/YYYY, HH:MM:SS AM/PM)
 */
export function formatDateTimeIN(date: string | Date | null | undefined): string {
  if (!date) return "-";

  const dateObj = typeof date === "string" ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return "-";
  }

  return dateObj.toLocaleString(INDIAN_LOCALE, {
    timeZone: INDIAN_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}
/**
 * Check if a service is within its renewal window (15 days before expiry)
 * or if it is already expired.
 */
export function isWithinRenewalWindow(expiryDate: string | Date | null | undefined): boolean {
  if (!expiryDate) return false;

  const d = typeof expiryDate === "string" ? new Date(expiryDate) : expiryDate;
  if (isNaN(d.getTime())) return false;

  const now = new Date();
  const diff = d.getTime() - now.getTime();

  // Return true if expiry is less than 15 days away (even if already expired)
  const fifteenDaysInMs = 15 * 24 * 60 * 60 * 1000;
  return diff <= fifteenDaysInMs;
}
