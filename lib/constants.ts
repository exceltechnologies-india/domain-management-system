export const INDIAN_STATES = [
  "Andaman and Nicobar Islands",
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chandigarh",
  "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jammu and Kashmir",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Ladakh",
  "Lakshadweep",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal"
] as const;

/**
 * Reverse-geocoding services (Nominatim, BigDataCloud, Google) return
 * Indian state names in inconsistent forms — "NCT of Delhi" instead of
 * "Delhi", "Orissa" instead of "Odisha", "Pondicherry" instead of
 * "Puducherry", and so on. Three places in the app run auto-detect on
 * an address form (guest checkout, dashboard settings, registration);
 * historically each implemented its own normaliser (or didn't, leaving
 * the state dropdown blank — which is what the senior reviewer hit on
 * 2026-06-22). This helper is the single source of truth: pass in the
 * raw provider-returned string, get back either an INDIAN_STATES entry
 * or an empty string (so the caller can leave the dropdown unchanged
 * rather than poisoning it with garbage).
 *
 * To handle a new alias: add an entry to STATE_ALIASES below. Keys must
 * be lowercase + trimmed; values must be an exact INDIAN_STATES entry.
 */
const STATE_ALIASES: Record<string, string> = {
  "national capital territory of delhi": "Delhi",
  "nct of delhi": "Delhi",
  "delhi nct": "Delhi",
  "new delhi": "Delhi",
  "orissa": "Odisha",
  "pondicherry": "Puducherry",
  "uttaranchal": "Uttarakhand",
  "jammu & kashmir": "Jammu and Kashmir",
  "j&k": "Jammu and Kashmir",
  "andaman & nicobar": "Andaman and Nicobar Islands",
  "andaman and nicobar": "Andaman and Nicobar Islands",
  "tamilnadu": "Tamil Nadu",
  "dadra and nagar haveli": "Dadra and Nagar Haveli and Daman and Diu",
  "daman and diu": "Dadra and Nagar Haveli and Daman and Diu",
};

export function normaliseIndianState(raw: string | null | undefined): string {
  if (!raw) return "";
  const k = String(raw).toLowerCase().trim();
  if (!k) return "";
  if (STATE_ALIASES[k]) return STATE_ALIASES[k];
  // Exact (case-insensitive) match against canonical list.
  const exact = INDIAN_STATES.find((s) => s.toLowerCase() === k);
  if (exact) return exact;
  // Substring fallback — covers "Delhi NCT" → "Delhi", "Karnataka State" →
  // "Karnataka", etc. Two-way check because the input might be a substring
  // of the canonical name OR the canonical name might be a substring of
  // a more verbose input.
  const fuzzy = INDIAN_STATES.find(
    (s) => k.includes(s.toLowerCase()) || s.toLowerCase().includes(k)
  );
  return fuzzy || "";
}
