import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Utility to merge Tailwind CSS classes using clsx and tailwind-merge
 * This prevents class conflicts and handles conditional classes efficiently.
 * @param inputs Array of class values, objects, or arrays
 * @returns A single string of merged class names
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Get support email from environment variable
 * Falls back to default support email if not set
 */
export function getSupportEmail(): string {
  return process.env.SUPPORT_EMAIL || "support@anutech.in";
}