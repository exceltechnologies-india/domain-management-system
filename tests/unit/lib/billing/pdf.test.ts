/**
 * Tests for `@/lib/billing/pdf` generateInvoicePdf — the shared generator
 * that replaced three near-identical copies (admin/orders, user/orders,
 * and the newly-added fallback in user/invoices/pdf). Pins:
 *  - invoiceProvider !== 'primary' -> "Proforma Invoice" title, flat
 *    total, "Proforma[-Admin]-{orderId}.pdf" filename (unchanged from the
 *    pre-refactor behavior — this is the path every existing order hits)
 *  - invoiceProvider === 'primary' with a GST breakdown -> "Tax Invoice"
 *    title, "Tax-Invoice-{invoiceNumber}.pdf" filename
 *  - company name/GSTIN come from getCompanyProfile(), not a literal
 */
import { describe, expect, it, vi } from "vitest";
import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";

vi.mock("@/lib/billing/companyProfile", () => ({
  getCompanyProfile: () => ({
    name: "Test Co Pvt Ltd",
    gstin: "07TESTGSTIN1Z1",
    state: "Delhi",
    address: "",
    supportEmail: "",
    sacCode: "998319",
  }),
}));

// tests/unit/setup.ts globally stubs next/server's NextResponse as a plain
// vi.fn() (no constructor) — the pdf generator needs the real `new
// NextResponse(buffer, init)` binary-response behavior.
vi.unmock("next/server");
const { NextResponse: RealNextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextResponse: RealNextResponse }));

const { generateInvoicePdf } = await import("@/lib/billing/pdf");

function baseOrder(overrides: Partial<IOrder> = {}): IOrder {
  return {
    orderId: "ORD-1",
    invoiceNumber: "INV-000001",
    currency: "INR",
    amount: 1180,
    createdAt: new Date("2026-01-01"),
    domains: [],
    ...overrides,
  } as unknown as IOrder;
}

function baseUser(overrides: Partial<IUser> = {}): IUser {
  return {
    firstName: "Jane",
    lastName: "Doe",
    ...overrides,
  } as unknown as IUser;
}

async function readPdfBytes(res: Response) {
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

describe("generateInvoicePdf — Proforma path (no primary GST breakdown)", () => {
  it("returns a PDF with the Proforma filename", async () => {
    const res = generateInvoicePdf(baseOrder(), baseUser());
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Proforma-ORD-1.pdf"'
    );
    const bytes = await readPdfBytes(res);
    expect(bytes.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("adds -Admin to the filename when adminContext is set", async () => {
    const res = generateInvoicePdf(baseOrder(), baseUser(), { adminContext: true });
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Proforma-Admin-ORD-1.pdf"'
    );
  });
});

describe("generateInvoicePdf — the domain shown on the line item", () => {
  // A hosting row's `domainName` is a SYNTHETIC cart-store id
  // ("hosting-Standard-1788506428638"); the domain the customer actually
  // bought the plan for is `linkedDomain`. Printing the raw id put an
  // internal identifier on a legally-numbered GST tax invoice — found on a
  // real rendered TI/2026-27/00001 on 2026-09-04. Zoho's builder already
  // resolved this correctly, so only our own engine was affected.
  const hostingOrder = () =>
    baseOrder({
      invoiceProvider: "primary",
      invoiceNumber: "TI/2026-27/00001",
      taxableValue: 1271.19,
      gstRate: 18,
      cgst: 114.41,
      sgst: 114.4,
      igst: 0,
      placeOfSupply: "Delhi",
      domains: [
        {
          domainName: "hosting-Standard-1788506428638",
          linkedDomain: "testing.com",
          price: 125,
          currency: "INR",
          registrationPeriod: 12,
          periodUnit: "months",
          itemType: "hosting",
          hostingPlan: { name: "Standard" },
        },
      ],
    } as unknown as Partial<IOrder>);

  it("shows the linked domain for a hosting item, never the synthetic cart id", async () => {
    const bytes = await readPdfBytes(generateInvoicePdf(hostingOrder(), baseUser()));
    const text = bytes.toString("latin1");
    expect(text).toContain("testing.com");
    expect(text).not.toContain("hosting-Standard-1788506428638");
  });

  it("falls back to domainName when a hosting item has no linkedDomain", async () => {
    const order = hostingOrder();
    delete (order.domains[0] as { linkedDomain?: string }).linkedDomain;
    const bytes = await readPdfBytes(generateInvoicePdf(order, baseUser()));
    expect(bytes.toString("latin1")).toContain("hosting-Standard-1788506428638");
  });

  it("keeps domainName for a DOMAIN item, where it is the real domain", async () => {
    const order = baseOrder({
      invoiceProvider: "primary",
      invoiceNumber: "TI/2026-27/00002",
      taxableValue: 1000,
      gstRate: 18,
      cgst: 90,
      sgst: 90,
      igst: 0,
      placeOfSupply: "Delhi",
      domains: [
        {
          domainName: "realdomain.com",
          price: 1000,
          currency: "INR",
          registrationPeriod: 1,
          periodUnit: "years",
          itemType: "domain",
        },
      ],
    } as unknown as Partial<IOrder>);
    const bytes = await readPdfBytes(generateInvoicePdf(order, baseUser()));
    expect(bytes.toString("latin1")).toContain("realdomain.com");
  });
});

describe("generateInvoicePdf — Tax Invoice path (invoiceProvider === 'primary')", () => {
  it("uses the Tax-Invoice filename keyed on invoiceNumber", async () => {
    const order = baseOrder({
      invoiceProvider: "primary",
      invoiceNumber: "TI/2026-27/00001",
      taxableValue: 1000,
      gstRate: 18,
      cgst: 90,
      sgst: 90,
      igst: 0,
      placeOfSupply: "Delhi",
    });
    const res = generateInvoicePdf(order, baseUser());
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Tax-Invoice-TI-2026-27-00001.pdf"'
    );
    const bytes = await readPdfBytes(res);
    expect(bytes.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("still renders successfully for an inter-state (IGST-only) breakdown", async () => {
    const order = baseOrder({
      invoiceProvider: "primary",
      invoiceNumber: "TI/2026-27/00002",
      taxableValue: 1000,
      gstRate: 18,
      cgst: 0,
      sgst: 0,
      igst: 180,
      placeOfSupply: "Maharashtra",
    });
    const res = generateInvoicePdf(order, baseUser());
    expect(res.status).toBe(200);
  });

  it("falls back to the Proforma path when taxableValue is absent even if invoiceProvider is 'primary'", async () => {
    // Guards against a half-populated order (e.g. a bug in Phase 1c) silently
    // claiming to be a Tax Invoice with no actual GST breakdown to show.
    const order = baseOrder({ invoiceProvider: "primary" });
    const res = generateInvoicePdf(order, baseUser());
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Proforma-ORD-1.pdf"'
    );
  });
});
