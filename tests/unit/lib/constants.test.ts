/**
 * Tests for `@/lib/constants` (rescan-4 slice 7dd).
 * INDIAN_STATES is consumed by the register form's state-select; this
 * file pins the count (36 entries — 28 states + 8 union territories),
 * the union-territory + state samples, and the alphabetical ordering.
 */
import { describe, it, expect } from "vitest";
import { INDIAN_STATES, normaliseIndianState } from "@/lib/constants";

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

describe("normaliseIndianState — used by all 3 auto-detect call sites (guest checkout, dashboard settings, registration)", () => {
  it("returns empty string on null / undefined / empty input — caller leaves dropdown unchanged", () => {
    expect(normaliseIndianState(null)).toBe("");
    expect(normaliseIndianState(undefined)).toBe("");
    expect(normaliseIndianState("")).toBe("");
    expect(normaliseIndianState("   ")).toBe("");
  });

  it("maps Nominatim's 'NCT of Delhi' / 'National Capital Territory of Delhi' / 'Delhi NCT' → 'Delhi'", () => {
    expect(normaliseIndianState("NCT of Delhi")).toBe("Delhi");
    expect(normaliseIndianState("National Capital Territory of Delhi")).toBe("Delhi");
    expect(normaliseIndianState("nct of delhi")).toBe("Delhi"); // case-insensitive
    expect(normaliseIndianState("  Delhi NCT  ")).toBe("Delhi"); // whitespace tolerant
  });

  it("maps historical / alternate names → canonical", () => {
    expect(normaliseIndianState("Orissa")).toBe("Odisha");
    expect(normaliseIndianState("Pondicherry")).toBe("Puducherry");
    expect(normaliseIndianState("Uttaranchal")).toBe("Uttarakhand");
    expect(normaliseIndianState("Tamilnadu")).toBe("Tamil Nadu");
    expect(normaliseIndianState("J&K")).toBe("Jammu and Kashmir");
    expect(normaliseIndianState("Jammu & Kashmir")).toBe("Jammu and Kashmir");
    expect(normaliseIndianState("Andaman & Nicobar")).toBe("Andaman and Nicobar Islands");
  });

  it("exact (case-insensitive) match against the canonical list passes through", () => {
    expect(normaliseIndianState("Delhi")).toBe("Delhi");
    expect(normaliseIndianState("delhi")).toBe("Delhi");
    expect(normaliseIndianState("Maharashtra")).toBe("Maharashtra");
    expect(normaliseIndianState("KARNATAKA")).toBe("Karnataka");
  });

  it("substring fuzzy fallback — verbose / abbreviated forms still resolve", () => {
    expect(normaliseIndianState("Karnataka State")).toBe("Karnataka");
    expect(normaliseIndianState("State of Maharashtra")).toBe("Maharashtra");
  });

  it("unknown garbage input → empty string (caller leaves dropdown unchanged)", () => {
    expect(normaliseIndianState("Atlantis")).toBe("");
    expect(normaliseIndianState("XYZ-123")).toBe("");
  });
});
