/**
 * The in-panel purchase helpers, and the pages they replaced.
 *
 * Owner decision, 24 Sep 2026: DMS's public frontend pages are removed (the
 * ResellerOS frontend is the one in use), and a signed-in customer buys from
 * small dialogs inside the panel instead.
 *
 * Threat model:
 *  - **A price that moved in the move.** The hosting cart lines were lifted
 *    from the deleted /hosting page; checkout and create-order depend on
 *    their exact shape. Pinned field by field, including the trial's ₹0
 *    today-charge and its post-trial rate.
 *  - **The DMS figures drifting from ResellerOS's.** The owner made
 *    ResellerOS's hosting prices the only ones. DMS still holds a copy, so
 *    the copy is pinned to the ResellerOS numbers as of that decision — a
 *    change to either has to be made to both, and this is where that fails.
 *  - **A deleted page coming back, or a link to one surviving.** Either would
 *    put a DMS marketing page (with DMS prices) in front of a customer again.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buyHref, parseBuyKind } from "@/lib/purchase/buy-dialog";
import { buildHostingCartItem, buildTrialCartItem } from "@/lib/purchase/hosting-cart-item";
import { HOSTING_PLANS } from "@/config/hosting-plans";
import type { CartItem } from "@/lib/types";

const starter = HOSTING_PLANS.starter;

describe("buyHref / parseBuyKind", () => {
  it("each kind opens on the panel page it belongs to", () => {
    expect(buyHref("hosting")).toBe("/dashboard/hosting?buy=hosting");
    expect(buyHref("domain")).toBe("/dashboard/domains?buy=domain");
  });

  it("carries a domain query, encoded, and ignores one for hosting", () => {
    expect(buyHref("domain", " my site ")).toBe("/dashboard/domains?buy=domain&q=my+site");
    expect(buyHref("hosting", "ignored")).toBe("/dashboard/hosting?buy=hosting");
  });

  it("opens nothing for anything but an exact kind", () => {
    expect(parseBuyKind("hosting")).toBe("hosting");
    expect(parseBuyKind("domain")).toBe("domain");
    for (const v of [null, undefined, "", "Hosting", "domains", "vps"]) {
      expect(parseBuyKind(v)).toBeNull();
    }
  });
});

describe("hosting prices match ResellerOS's (owner decision 7, 24 Sep 2026)", () => {
  it("per-month rate on yearly billing is ResellerOS's LANDING_PLANS figure", () => {
    // ResellerOS production/src/site/lib/data/hosting-landing.ts, 24 Sep 2026.
    expect(HOSTING_PLANS.starter.price).toBe(49.99);
    expect(HOSTING_PLANS.standard.price).toBe(125);
    expect(HOSTING_PLANS.plus.price).toBe(187.2);
  });

  // What is CHARGED from those figures (ResellerOS's rate + 18% GST) is
  // pinned in tests/unit/lib/pricing/hosting-price.test.ts.
});

describe("buildHostingCartItem — the old page's shape, at ResellerOS's price incl. GST", () => {
  it("yearly: 12 months totalling ₹708, with the money-back line", () => {
    const item = buildHostingCartItem(starter, "yearly", [], 1000);
    expect(item).toEqual({
      domainName: "hosting-starter-1000",
      price: 59, // ₹708 ÷ 12
      currency: "INR",
      registrationPeriod: 12,
      periodUnit: "months",
      itemType: "hosting",
      billingCycle: "yearly",
      hostingPlan: {
        id: "starter",
        name: "Starter Hosting",
        period: 12,
        features: [...starter.features, "30-Day Money-Back Guarantee"],
        serverPackage: "Starter",
      },
    });
  });

  it("monthly: 1 month at ₹118 (₹100 + GST), no money-back line", () => {
    const item = buildHostingCartItem(starter, "monthly", [], 1000);
    expect(item.price).toBe(118);
    expect(item.registrationPeriod).toBe(1);
    expect(item.hostingPlan?.features).toEqual(starter.features);
  });

  it("links to a domain already in the cart", () => {
    const cart: CartItem[] = [{ domainName: "example.in", price: 700, currency: "INR", registrationPeriod: 1, itemType: "domain" }];
    expect(buildHostingCartItem(starter, "yearly", cart).linkedDomain).toBe("example.in");
  });

  it("does not double-link a domain another hosting line already has", () => {
    const cart: CartItem[] = [
      { domainName: "example.in", price: 700, currency: "INR", registrationPeriod: 1, itemType: "domain" },
      { domainName: "hosting-plus-1", price: 187.2, currency: "INR", registrationPeriod: 12, itemType: "hosting", linkedDomain: "example.in" },
    ];
    expect(buildHostingCartItem(starter, "yearly", cart).linkedDomain).toBeUndefined();
  });
});

describe("buildTrialCartItem", () => {
  it("₹0 today for 15 days, carrying the post-trial rate (₹708 a year ÷ 12)", () => {
    const item = buildTrialCartItem(starter, 1000);
    expect(item.price).toBe(0);
    expect(item.registrationPeriod).toBe(15);
    expect(item.periodUnit).toBe("days");
    expect(item.isTrial).toBe(true);
    expect(item.billingCycle).toBe("yearly");
    expect(item.hostingPlan?.price).toBe(59);
    expect(item.domainName).toBe("hosting-trial-starter-1000");
  });
});

describe("the deleted public pages stay deleted", () => {
  const ROOT = process.cwd();
  const DELETED = [
    "app/page.tsx",
    "app/about",
    "app/contact",
    "app/privacy",
    "app/terms-and-conditions",
    "app/cancellation-refund",
    "app/data-deletion",
    "app/domains-home",
    "app/domains",
    "app/hosting/page.tsx",
    "components/marketing",
  ];

  it.each(DELETED)("%s does not exist", (p) => {
    // If one is being restored on purpose, remove its entry from
    // RESELLEROS_OWNED_PAGES in lib/reseller-os.ts in the same change —
    // otherwise the middleware redirects every visitor away from it.
    expect(existsSync(join(ROOT, p))).toBe(false);
  });

  it("the SSO error page survives — it is a panel page, not marketing", () => {
    expect(existsSync(join(ROOT, "app/hosting/error/page.tsx"))).toBe(true);
  });

  it("no source file links straight to a deleted page", () => {
    /**
     * A literal href to one of these would 404 with the front door unset and
     * take a redirect hop with it set. Links go through publicPageHref() or
     * buyHref(); lib/reseller-os.ts is the map itself, so it is exempt.
     */
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e.startsWith(".")) continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e)) files.push(p);
      }
    };
    for (const d of ["app", "components", "lib"]) walk(join(ROOT, d));
    expect(files.length, "scan found nothing — has the tree moved?").toBeGreaterThan(200);

    const pattern =
      /(?:href=|push\(|href:\s*)["'`](\/(?:hosting|domains-home|domains\/search|domains\/bulk-search|data-deletion|about|contact|privacy|terms-and-conditions|cancellation-refund))(?:[#?"'`])/;
    const offenders = files
      .filter((f) => !f.endsWith(join("lib", "reseller-os.ts")))
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f).split("\\").join("/"));
    expect(offenders).toEqual([]);
  });
});
