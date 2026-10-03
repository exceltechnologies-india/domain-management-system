/**
 * The cart asks for a complete profile (phone + address) only when it holds a DOMAIN (Pawan,
 * 3 Oct 2026: "hide the banner for customers who have no domains; when they try to buy a domain,
 * prompt them"). A hosting-only order is not sent to Settings; it is still asked for its state at
 * payment (PanelCheckout). Source scan, like the other page-wiring pins.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "app/cart/page.tsx"), "utf8");

describe("cart: the profile is asked for only with a domain in the cart", () => {
  it("knows whether the cart holds a domain (a missing itemType counts as a domain)", () => {
    expect(src).toMatch(/const cartHasDomain = cartItems\.some\(\(i\) => i\.itemType !== 'hosting'\)/);
  });
  it("the banner shows only then", () => {
    expect(src).toMatch(/\{cartHasDomain && <ProfileCompletionWarning returnUrl="\/cart" \/>\}/);
  });
  it("the 'Complete Profile First' button and the checkout gate only then", () => {
    expect(src).toMatch(/profileCompleted=\{cartHasDomain \? user\?\.profileCompleted : true\}/);
    expect(src).toMatch(/latestProfileCompleted !== true && cartItems\.some\(\(i\) => i\.itemType !== 'hosting'\)/);
  });
  it("the panel shell shows the banner only to customers with a domain", () => {
    expect(readFileSync(join(process.cwd(), "components/user/UserLayout.tsx"), "utf8")).toContain("<ProfileCompletionWarning onlyWithDomains />");
  });
});
