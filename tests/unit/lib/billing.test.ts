/**
 * Tests for `@/lib/billing` (rescan-4 slice 7du).
 * Cart-item type inference + expiration date math. Pins:
 *  - isHostingItem: itemType priority + hostingPlan-data fallback +
 *    'hosting-' placeholder domain
 *  - inferPeriodUnit: explicit periodUnit wins, hosting+10 → minutes
 *    (test cycle), hosting else → months, domain → years
 *  - isDomainItem: itemType priority + inverse of isHostingItem
 *  - calculateItemExpiration: hosting → months/days, domain → years,
 *    duration > 10 forces monthly (defence against the 2038 bug —
 *    `12 months` registered as 12 YEARS would crash addTime arithmetic)
 *  - validateCartItem: missing domainName / price → string error
 */
import { describe, it, expect } from "vitest";
import {
  isHostingItem,
  inferPeriodUnit,
  isDomainItem,
  calculateItemExpiration,
  validateCartItem,
} from "@/lib/billing";
import type { CartItem } from "@/lib/types";

function item(overrides: Partial<CartItem> = {}): CartItem {
  return {
    domainName: "example.com",
    price: 999,
    registrationPeriod: 1,
    ...overrides,
  } as CartItem;
}

describe("isHostingItem", () => {
  it("itemType='hosting' → true (priority)", () => {
    expect(isHostingItem(item({ itemType: "hosting" }))).toBe(true);
  });

  it("itemType='domain' + no hosting-data → false", () => {
    expect(isHostingItem(item({ itemType: "domain" }))).toBe(false);
  });

  it("hostingPlan.name supplied + no itemType → true (substantive hosting data)", () => {
    expect(
      isHostingItem(
        item({
          itemType: undefined as never,
          hostingPlan: { name: "Starter" } as never,
        })
      )
    ).toBe(true);
  });

  it("'hosting-' placeholder domainName → true (mislabeled trial-item catch)", () => {
    expect(
      isHostingItem(
        item({ itemType: undefined as never, domainName: "hosting-abc-123" })
      )
    ).toBe(true);
  });

  it("'hosting-' placeholder beats itemType='domain' (placeholder check runs first as a mislabel-catch)", () => {
    // Source comment: "We check this BEFORE the domain-type check to catch
    // mislabeled trial items" — a placeholder domain wins over a domain
    // itemType label.
    expect(
      isHostingItem(item({ itemType: "domain", domainName: "hosting-x" }))
    ).toBe(true);
  });

  it("no itemType + no hosting-data + regular domain → false", () => {
    expect(
      isHostingItem(item({ itemType: undefined as never, domainName: "example.com" }))
    ).toBe(false);
  });
});

describe("inferPeriodUnit", () => {
  it("explicit periodUnit wins", () => {
    expect(inferPeriodUnit(item({ periodUnit: "days" }))).toBe("days");
    expect(inferPeriodUnit(item({ periodUnit: "years" }))).toBe("years");
  });

  it("hosting + registrationPeriod=10 → 'minutes' (test cycle)", () => {
    expect(
      inferPeriodUnit(item({ itemType: "hosting", registrationPeriod: 10 }))
    ).toBe("minutes");
  });

  it("hosting + registrationPeriod=12 → 'months' (not minutes)", () => {
    expect(
      inferPeriodUnit(item({ itemType: "hosting", registrationPeriod: 12 }))
    ).toBe("months");
  });

  it("hosting + registrationPeriod=1 → 'months'", () => {
    expect(
      inferPeriodUnit(item({ itemType: "hosting", registrationPeriod: 1 }))
    ).toBe("months");
  });

  it("domain → 'years' regardless of registrationPeriod", () => {
    expect(inferPeriodUnit(item({ itemType: "domain", registrationPeriod: 1 }))).toBe(
      "years"
    );
    expect(inferPeriodUnit(item({ itemType: "domain", registrationPeriod: 5 }))).toBe(
      "years"
    );
  });
});

describe("isDomainItem", () => {
  it("itemType='domain' → true; itemType='hosting' → false", () => {
    expect(isDomainItem(item({ itemType: "domain" }))).toBe(true);
    expect(isDomainItem(item({ itemType: "hosting" }))).toBe(false);
  });

  it("no itemType + no hosting hint → true (default to domain)", () => {
    expect(
      isDomainItem(item({ itemType: undefined as never, domainName: "example.com" }))
    ).toBe(true);
  });

  it("'hosting-' placeholder + no itemType → false (hosting wins)", () => {
    expect(
      isDomainItem(item({ itemType: undefined as never, domainName: "hosting-x" }))
    ).toBe(false);
  });
});

describe("calculateItemExpiration", () => {
  it("hosting + registrationPeriod=1 → +1 month, unit='month'", () => {
    const now = new Date();
    const result = calculateItemExpiration(item({ itemType: "hosting", registrationPeriod: 1 }));
    expect(result.itemType).toBe("hosting");
    expect(result.periodUnit).toBe("month");
    expect(result.duration).toBe(1);
    // Expires within ~1 month (allow second-level drift).
    expect(result.expiresAt.getMonth()).toBe((now.getMonth() + 1) % 12);
  });

  it("hosting + periodUnit='days' + registrationPeriod=7 → +7 days", () => {
    const now = new Date();
    const result = calculateItemExpiration(
      item({ itemType: "hosting", periodUnit: "days", registrationPeriod: 7 })
    );
    expect(result.periodUnit).toBe("days");
    expect(result.expiresAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("domain → +N years, unit='year'", () => {
    const now = new Date();
    const result = calculateItemExpiration(
      item({ itemType: "domain", registrationPeriod: 2 })
    );
    expect(result.itemType).toBe("domain");
    expect(result.periodUnit).toBe("year");
    expect(result.expiresAt.getFullYear()).toBe(now.getFullYear() + 2);
  });

  it("duration > 10 forces hosting/monthly even when itemType='domain' (2038-bug defense)", () => {
    const result = calculateItemExpiration(
      item({ itemType: "domain", registrationPeriod: 12 })
    );
    // Despite itemType='domain', duration=12 forces monthly interpretation.
    expect(result.itemType).toBe("hosting");
    expect(result.periodUnit).toBe("month");
  });

  it("default registrationPeriod when missing/0 falls back to 1", () => {
    const result = calculateItemExpiration(
      item({ itemType: "domain", registrationPeriod: undefined as unknown as number })
    );
    expect(result.duration).toBe(1);
  });
});

describe("validateCartItem", () => {
  it("hosting item missing hostingPlan → error string", () => {
    expect(
      validateCartItem(item({ itemType: "hosting", hostingPlan: undefined as never }))
    ).toMatch(/missing 'hostingPlan'/);
  });

  it("missing domainName → 'Missing domain name'", () => {
    expect(
      validateCartItem(
        item({ itemType: "domain", domainName: undefined as unknown as string })
      )
    ).toBe("Missing domain name");
  });

  it("missing price → 'Missing price'", () => {
    expect(
      validateCartItem(item({ itemType: "domain", price: undefined as unknown as number }))
    ).toBe("Missing price");
  });

  it("valid domain item → null", () => {
    expect(validateCartItem(item({ itemType: "domain" }))).toBeNull();
  });

  it("valid hosting item with hostingPlan → null", () => {
    expect(
      validateCartItem(
        item({
          itemType: "hosting",
          hostingPlan: { name: "Starter", period: 1, features: [] } as never,
        })
      )
    ).toBeNull();
  });
});
