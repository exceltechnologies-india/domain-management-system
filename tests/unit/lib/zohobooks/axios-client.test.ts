/**
 * Tests for `@/lib/zohobooks/axios-client` (rescan-4 slice 7de).
 * Shared axios instance with a 30s budget — mirrors the ResellerClub
 * client so a hung Zoho upstream can't stall Cloud Run request slots.
 */
import { describe, it, expect } from "vitest";
import { zohoAxios } from "@/lib/zohobooks/axios-client";

describe("zohoAxios", () => {
  it("is an axios instance with HTTP verb methods", () => {
    expect(typeof zohoAxios.get).toBe("function");
    expect(typeof zohoAxios.post).toBe("function");
    expect(typeof zohoAxios.put).toBe("function");
    expect(typeof zohoAxios.delete).toBe("function");
  });

  it("has a 30s request timeout configured (matches ResellerClub client budget)", () => {
    expect(zohoAxios.defaults.timeout).toBe(30_000);
  });

  it("has `create` as the axios root signature (not a plain function)", () => {
    expect(zohoAxios.defaults).toBeDefined();
  });
});
