/** The footer's "We Accept" names only what checkout takes (Razorpay): no PayPal (6 Oct 2026). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("footer payment badges", () => {
  it.each(["components/FooterModern.tsx", "components/FooterClassic.tsx"])("%s offers no PayPal", (f) => {
    const code = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/PayPal/i);
  });
});
