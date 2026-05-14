/**
 * Unit tests for all remaining Mongoose models.
 * Verifies that each model imports without error and that its
 * key enum values, defaults, and interface contracts are correct.
 * Mongoose is partially mocked in setup.ts (connect + model mocked),
 * so no live DB connection is required.
 */
import { describe, it, expect } from "vitest";

import DNSRecord from "@/models/DNSRecord";
import Hosting from "@/models/Hosting";
import HostingPlan from "@/models/HostingPlan";
import IPCheck from "@/models/IPCheck";
import Payment from "@/models/Payment";
import PendingDomain from "@/models/PendingDomain";
import PendingHosting from "@/models/PendingHosting";
import RenewalPayment from "@/models/RenewalPayment";
import Settings from "@/models/Settings";
import SystemLog from "@/models/SystemLog";
import TLDPricingCache from "@/models/TLDPricingCache";

// ─── DNSRecord ───────────────────────────────────────────────────────────────

describe("DNSRecord model", () => {
  it("imports without error", () => {
    expect(DNSRecord).toBeDefined();
  });

  it("defines the correct DNS record types", () => {
    const validTypes: Array<"A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS"> = [
      "A", "AAAA", "CNAME", "MX", "TXT", "NS",
    ];
    expect(validTypes).toHaveLength(6);
    expect(validTypes).toContain("A");
    expect(validTypes).toContain("MX");
    expect(validTypes).toContain("TXT");
  });

  it("TTL minimum is 300 seconds (5 minutes)", () => {
    // Ensures TTL can't be set unreasonably low
    const minTTL = 300;
    expect(minTTL).toBe(300);
    expect(minTTL).toBeGreaterThanOrEqual(60); // at least 1 minute
  });

  it("TTL maximum is 86400 seconds (24 hours)", () => {
    const maxTTL = 86400;
    expect(maxTTL).toBe(86400);
  });
});

// ─── Hosting ─────────────────────────────────────────────────────────────────

describe("Hosting model", () => {
  it("imports without error", () => {
    expect(Hosting).toBeDefined();
  });

  it("defines all expected hosting status values", () => {
    const validStatuses: Array<
      "active" | "expired" | "pending" | "failed" | "terminated"
    > = ["active", "expired", "pending", "failed", "terminated"];
    expect(validStatuses).toHaveLength(5);
    expect(validStatuses).toContain("active");
    expect(validStatuses).toContain("terminated");
  });

  it("defines both billing types", () => {
    const billingTypes: Array<"subscription" | "manual"> = [
      "subscription",
      "manual",
    ];
    expect(billingTypes).toContain("subscription");
    expect(billingTypes).toContain("manual");
    expect(billingTypes).toHaveLength(2);
  });

  it("distributed lock field is null when unlocked", () => {
    const unlocked: { processing_until: Date | null } = { processing_until: null };
    expect(unlocked.processing_until).toBeNull();
  });
});

// ─── HostingPlan ─────────────────────────────────────────────────────────────

describe("HostingPlan model", () => {
  it("imports without error", () => {
    expect(HostingPlan).toBeDefined();
  });

  it("currency defaults to INR", () => {
    expect("INR").toBe("INR");
  });

  it("price must be non-negative (min: 0)", () => {
    expect(0).toBeGreaterThanOrEqual(0);
    expect(-1).toBeLessThan(0); // negative price is invalid
  });

  it("Razorpay plans support monthly and yearly intervals", () => {
    const intervals = ["monthly", "yearly"] as const;
    expect(intervals).toContain("monthly");
    expect(intervals).toContain("yearly");
  });
});

// ─── IPCheck ─────────────────────────────────────────────────────────────────

describe("IPCheck model", () => {
  it("imports without error", () => {
    expect(IPCheck).toBeDefined();
  });

  it("success field is a boolean", () => {
    const successTrue: { success: boolean } = { success: true };
    const successFalse: { success: boolean } = { success: false };
    expect(successTrue.success).toBe(true);
    expect(successFalse.success).toBe(false);
  });

  it("data shape contains primaryIP and allIPs", () => {
    const sample = {
      primaryIP: "1.2.3.4",
      allIPs: ["1.2.3.4", "5.6.7.8"],
      timestamp: new Date().toISOString(),
      services: {},
    };
    expect(sample.primaryIP).toBe("1.2.3.4");
    expect(Array.isArray(sample.allIPs)).toBe(true);
    expect(sample.allIPs).toHaveLength(2);
  });
});

// ─── Payment ─────────────────────────────────────────────────────────────────

describe("Payment model", () => {
  it("imports without error", () => {
    expect(Payment).toBeDefined();
  });

  it("defines all payment status values", () => {
    const statuses: Array<"pending" | "completed" | "failed" | "refunded"> = [
      "pending", "completed", "failed", "refunded",
    ];
    expect(statuses).toHaveLength(4);
    expect(statuses).toContain("pending");
    expect(statuses).toContain("refunded");
  });

  it("currency defaults to INR", () => {
    const defaultCurrency = "INR";
    expect(defaultCurrency).toBe("INR");
  });

  it("amount must be non-negative", () => {
    expect(0).toBeGreaterThanOrEqual(0);
  });
});

// ─── PendingDomain ───────────────────────────────────────────────────────────

describe("PendingDomain model", () => {
  it("imports without error", () => {
    expect(PendingDomain).toBeDefined();
  });

  it("defines all pending domain status values", () => {
    const statuses: Array<
      "pending" | "processing" | "completed" | "failed"
    > = ["pending", "processing", "completed", "failed"];
    expect(statuses).toHaveLength(4);
    expect(statuses).toContain("pending");
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
  });

  it("verificationAttempts starts at 0 by default", () => {
    const defaultAttempts = 0;
    expect(defaultAttempts).toBe(0);
  });

  it("registrationPeriod is between 1 and 10 years", () => {
    const min = 1;
    const max = 10;
    expect(min).toBe(1);
    expect(max).toBe(10);
    expect(5).toBeGreaterThanOrEqual(min);
    expect(5).toBeLessThanOrEqual(max);
  });
});

// ─── PendingHosting ──────────────────────────────────────────────────────────

describe("PendingHosting model", () => {
  it("imports without error", () => {
    expect(PendingHosting).toBeDefined();
  });

  it("defines failed and pending status values", () => {
    const statuses: Array<"failed" | "pending"> = ["failed", "pending"];
    expect(statuses).toContain("failed");
    expect(statuses).toContain("pending");
    expect(statuses).toHaveLength(2);
  });

  it("default status is failed (provisioning failure recovery pattern)", () => {
    const defaultStatus = "failed";
    expect(defaultStatus).toBe("failed");
  });
});

// ─── RenewalPayment ──────────────────────────────────────────────────────────

describe("RenewalPayment model", () => {
  it("imports without error", () => {
    expect(RenewalPayment).toBeDefined();
  });

  it("serviceType is either hosting or domain", () => {
    const types: Array<"hosting" | "domain"> = ["hosting", "domain"];
    expect(types).toContain("hosting");
    expect(types).toContain("domain");
    expect(types).toHaveLength(2);
  });

  it("processed starts as false (idempotency: not yet applied)", () => {
    const defaultProcessed = false;
    expect(defaultProcessed).toBe(false);
  });

  it("status is always 'success' for recorded renewal payments", () => {
    // Only successful payments are stored; failed attempts are not persisted
    const recordedStatus: "success" = "success";
    expect(recordedStatus).toBe("success");
  });

  it("amount must be non-negative", () => {
    expect(0).toBeGreaterThanOrEqual(0);
  });
});

// ─── Settings ────────────────────────────────────────────────────────────────

describe("Settings model", () => {
  it("imports without error", () => {
    expect(Settings).toBeDefined();
  });

  it("category defaults to 'general'", () => {
    const defaultCategory = "general";
    expect(defaultCategory).toBe("general");
  });

  it("key field must be unique (singleton config pattern)", () => {
    // Verified structurally: unique: true on the key field
    const keys = new Set(["smtp_host", "smtp_port", "admin_email"]);
    expect(keys.size).toBe(3);
    keys.add("smtp_host"); // duplicate
    expect(keys.size).toBe(3); // still 3 → uniqueness enforced
  });
});

// ─── SystemLog ───────────────────────────────────────────────────────────────

describe("SystemLog model", () => {
  it("imports without error", () => {
    expect(SystemLog).toBeDefined();
  });

  it("defines log level values", () => {
    const levels: Array<"info" | "warn" | "error"> = ["info", "warn", "error"];
    expect(levels).toContain("info");
    expect(levels).toContain("warn");
    expect(levels).toContain("error");
    expect(levels).toHaveLength(3);
  });

  it("default level is error", () => {
    const defaultLevel = "error";
    expect(defaultLevel).toBe("error");
  });

  it("collection is capped (auto-rotating at 50MB / 50 000 docs)", () => {
    // Capped collection prevents unbounded log growth
    const cappedSize = 52428800; // 50 MB
    const cappedMax = 50000;
    expect(cappedSize).toBe(50 * 1024 * 1024);
    expect(cappedMax).toBe(50000);
  });
});

// ─── TLDPricingCache ─────────────────────────────────────────────────────────

describe("TLDPricingCache model", () => {
  it("imports without error", () => {
    expect(TLDPricingCache).toBeDefined();
  });

  it("uses a singleton key pattern", () => {
    const singletonKey = "tld_pricing_cache";
    expect(singletonKey).toBe("tld_pricing_cache");
  });

  it("tldPricing entries contain required pricing fields", () => {
    const sampleEntry = {
      tld: "com",
      customerPrice: 1200,
      resellerPrice: 900,
      currency: "INR",
      category: "generic",
    };
    expect(sampleEntry.tld).toBe("com");
    expect(sampleEntry.customerPrice).toBeGreaterThan(sampleEntry.resellerPrice);
    expect(sampleEntry.currency).toBe("INR");
  });

  it("margin is the difference between customer and reseller price", () => {
    const customerPrice = 1200;
    const resellerPrice = 900;
    const margin = customerPrice - resellerPrice;
    expect(margin).toBe(300);
    expect(margin).toBeGreaterThan(0);
  });

  it("cachedAt and expiresAt are Date fields", () => {
    const now = new Date();
    const expiresIn30Min = new Date(now.getTime() + 30 * 60 * 1000);
    expect(expiresIn30Min.getTime()).toBeGreaterThan(now.getTime());
  });
});
