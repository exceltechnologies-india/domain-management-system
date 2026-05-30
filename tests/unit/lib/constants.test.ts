/**
 * Tests for `@/lib/constants` (rescan-4 slice 7dd).
 * INDIAN_STATES is consumed by the register form's state-select; this
 * file pins the count (36 entries — 28 states + 8 union territories),
 * the union-territory + state samples, and the alphabetical ordering.
 */
import { describe, it, expect } from "vitest";
import { INDIAN_STATES } from "@/lib/constants";

describe("INDIAN_STATES", () => {
  it("has 36 entries (28 states + 8 union territories)", () => {
    expect(INDIAN_STATES).toHaveLength(36);
  });

  it("contains all 28 Indian states", () => {
    const states = [
      "Andhra Pradesh",
      "Arunachal Pradesh",
      "Assam",
      "Bihar",
      "Chhattisgarh",
      "Goa",
      "Gujarat",
      "Haryana",
      "Himachal Pradesh",
      "Jharkhand",
      "Karnataka",
      "Kerala",
      "Madhya Pradesh",
      "Maharashtra",
      "Manipur",
      "Meghalaya",
      "Mizoram",
      "Nagaland",
      "Odisha",
      "Punjab",
      "Rajasthan",
      "Sikkim",
      "Tamil Nadu",
      "Telangana",
      "Tripura",
      "Uttar Pradesh",
      "Uttarakhand",
      "West Bengal",
    ];
    for (const state of states) {
      expect(INDIAN_STATES).toContain(state);
    }
  });

  it("contains the 8 union territories", () => {
    const uts = [
      "Andaman and Nicobar Islands",
      "Chandigarh",
      "Dadra and Nagar Haveli and Daman and Diu",
      "Delhi",
      "Jammu and Kashmir",
      "Ladakh",
      "Lakshadweep",
      "Puducherry",
    ];
    for (const ut of uts) {
      expect(INDIAN_STATES).toContain(ut);
    }
  });

  it("is sorted alphabetically (drives the register form's dropdown ordering)", () => {
    const sorted = [...INDIAN_STATES].sort((a, b) => a.localeCompare(b));
    expect([...INDIAN_STATES]).toEqual(sorted);
  });
});
