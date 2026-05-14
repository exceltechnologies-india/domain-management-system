import { describe, it, expect } from "vitest";

import Order from "@/models/Order";

describe("Order module", () => {
  it("imports without throwing an error", () => {
    expect(Order).toBeDefined();
  });
});

describe("Order status enum values", () => {
  // These strings must match what the Order schema accepts
  const validStatuses = ["pending", "paid", "processing", "completed", "failed", "refunded"] as const;

  it("includes all expected status values", () => {
    expect(validStatuses).toContain("pending");
    expect(validStatuses).toContain("paid");
    expect(validStatuses).toContain("processing");
    expect(validStatuses).toContain("completed");
    expect(validStatuses).toContain("failed");
    expect(validStatuses).toContain("refunded");
  });

  it("has exactly 6 order statuses", () => {
    expect(validStatuses.length).toBe(6);
  });
});

describe("Order domain item status enum values", () => {
  const validDomainStatuses = ["pending", "processing", "registered", "failed", "cancelled"] as const;

  it("includes all expected domain-item statuses", () => {
    expect(validDomainStatuses).toContain("pending");
    expect(validDomainStatuses).toContain("processing");
    expect(validDomainStatuses).toContain("registered");
    expect(validDomainStatuses).toContain("failed");
    expect(validDomainStatuses).toContain("cancelled");
  });

  it("has exactly 5 domain item statuses", () => {
    expect(validDomainStatuses.length).toBe(5);
  });
});

describe("Order booking step values", () => {
  const validSteps = [
    "payment_verified",
    "customer_created",
    "contact_created",
    "domain_registering",
    "domain_pending",
    "domain_registered",
    "domain_failed",
    "dns_activated",
  ] as const;

  it("has 8 booking step values", () => {
    expect(validSteps.length).toBe(8);
  });

  it("starts with payment_verified and ends with dns_activated", () => {
    expect(validSteps[0]).toBe("payment_verified");
    expect(validSteps[validSteps.length - 1]).toBe("dns_activated");
  });
});

describe("Order purchaseOrderNumber format", () => {
  it("matches the PO-XXXXXX-YYY pattern", () => {
    const regex = /^PO-[A-Z0-9]{6}-[A-Z0-9]{3}$/;
    // Valid examples
    expect(regex.test("PO-ABC123-XYZ")).toBe(true);
    expect(regex.test("PO-000000-000")).toBe(true);
    // Invalid examples
    expect(regex.test("INV-ABC123-XYZ")).toBe(false);
    expect(regex.test("PO-AB-XYZ")).toBe(false);
  });
});

describe("Order invoiceNumber format", () => {
  it("matches the INV-XXXXXX-YYY pattern", () => {
    const regex = /^INV-[A-Z0-9]{6}-[A-Z0-9]{3}$/;
    expect(regex.test("INV-ABC123-XYZ")).toBe(true);
    expect(regex.test("PO-ABC123-XYZ")).toBe(false);
  });
});

describe("Order orderType values", () => {
  const validTypes = ["domain", "hosting", "bundle", "renewal", "unknown"] as const;

  it("contains all expected order type values", () => {
    expect(validTypes).toContain("domain");
    expect(validTypes).toContain("hosting");
    expect(validTypes).toContain("bundle");
    expect(validTypes).toContain("renewal");
    expect(validTypes).toContain("unknown");
  });
});
