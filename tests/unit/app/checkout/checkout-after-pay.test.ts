/**
 * app/checkout — two defects found by the 6 Oct 2026 end-to-end run (two hosting plans from
 * the cart, paid through ResellerOS's Razorpay test checkout).
 *
 * 1. After paying, the page showed grey loading boxes forever: onPaid empties the cart, and an
 *    empty cart renders the skeleton, which unmounted PanelCheckout's "Payment received".
 * 2. A hosting-only cart was sent back to the cart for an incomplete profile, while the cart page
 *    lets a hosting-only cart through (profile only for domains, 3 Oct 2026) — a loop.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(process.cwd(), "app/checkout/page.tsx"), "utf8");
const panel = readFileSync(join(process.cwd(), "components/purchase/PanelCheckout.tsx"), "utf8");

describe("checkout after a paid cart", () => {
  it("keeps its own Payment received screen, ahead of the empty-cart skeleton", () => {
    const paidAt = page.indexOf("if (paidQuoteId !== undefined)");
    const skeletonAt = page.indexOf("if (!user || isLoading || cartItems.length === 0)");
    expect(paidAt).toBeGreaterThan(-1);
    expect(paidAt).toBeLessThan(skeletonAt);
    expect(page.slice(paidAt, skeletonAt)).toMatch(/Payment received/);
    expect(page.slice(paidAt, skeletonAt)).toMatch(/Go to Invoices/);
  });

  it("records the paid bill's number before the cart is emptied", () => {
    expect(page).toMatch(/onPaid=\{\(quoteId\) => \{\s*setPaymentCompleted\(true\);\s*setPaidQuoteId\(quoteId \?\? null\);\s*clearCart\(\);/);
    expect(panel).toContain("onPaid?.(order.quoteId);");
  });
});

describe("checkout asks for the full profile only for a domain", () => {
  it("a hosting-only cart is not sent back for an incomplete profile", () => {
    expect(page).toMatch(/const cartNow = cartItemsRef\.current;/);
    expect(page).toMatch(/const needsProfile = cartNow\.some\(\(i: CartItem\) => i\.itemType !== 'hosting'\);/);
    expect(page).toMatch(/if \(needsProfile && profileCompleted !== true\)/);
    expect(page).not.toMatch(/\n\s*if \(profileCompleted !== true\) \{/);
  });
});
