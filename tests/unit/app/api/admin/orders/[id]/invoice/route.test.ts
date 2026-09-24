/**
 * Tests for `app/api/admin/orders/[id]/invoice/route.ts` (slice 7i8,
 * part 2).
 *
 * Admin-facing invoice PDF download (mirror of the customer endpoint,
 * but with the admin gate and NO IDOR scoping — admins can fetch
 * any customer's invoice).
 *
 * Pins:
 *  - **Admin-only**: AuthService.getAdminFromRequest → 401 on miss.
 *    No order lookup runs if the gate fails.
 *  - **No IDOR scoping**: getOrderByIdOrOrderId(id) — admin can fetch any
 *    order regardless of which customer owns it.
 *  - **Customer hydration**: after order load, getUserById(order.userId)
 *    fetches the customer's profile (for the Bill-To section). Missing
 *    customer → 404 'Customer not found' (separate from order 404).
 *  - **Always rendered locally** (Zoho Books removed 24 Sep 2026): every
 *    order goes through generateInvoicePdf. A primary-engine order with a
 *    GST breakdown is a Tax Invoice; anything else — including a
 *    historical `invoiceProvider: 'zoho'` order — is a Proforma copy.
 *  - **Filename construction**:
 *    - Tax Invoice: `Tax-Invoice-${invoiceNumber with / → -}.pdf`
 *    - Proforma: `Proforma-Admin-${orderId}.pdf` — the Admin suffix
 *      distinguishes admin downloads from customer proformas.
 *  - **404 distinction**: missing order → 'Order not found';
 *    missing customer → 'Customer not found'. Different bodies so
 *    admin debugging is unambiguous (NOT an anti-enumeration concern
 *    here because admin is already trusted).
 *  - **Outer catch → 500 'Internal Server Error' generic** — no leak.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getOrderByIdOrOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ getOrderByIdOrOrderId }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/dateUtils", () => ({
  formatIndianDate: (d: Date | string) => `IST(${String(d)})`,
}));

vi.mock("@/lib/invoiceUtils", () => ({
  SAC_CODE: "998314",
  formatSubscriptionPeriod: () => "01 Jan 2026 - 31 Dec 2026",
  formatQuantityText: () => "1\nyear",
}));

vi.mock("jspdf", () => {
  class FakePdf {
    setFont = vi.fn();
    setFontSize = vi.fn();
    setTextColor = vi.fn();
    setFillColor = vi.fn();
    setDrawColor = vi.fn();
    rect = vi.fn();
    line = vi.fn();
    text = vi.fn();
    output(kind: string) {
      if (kind === "arraybuffer") return new ArrayBuffer(8);
      return "";
    }
  }
  return { default: FakePdf };
});

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/orders/[id]/invoice/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/admin/orders/ORD-1/invoice",
    { method: "GET" }
  );
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const admin = { _id: "A1", email: "admin@x.com", role: "admin" };

const customer = {
  _id: "U1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Doe",
  address: { line1: "1 Test", city: "Delhi", state: "Delhi", zipcode: "110001", country: "IN" },
};

interface FakeOrder {
  orderId: string;
  userId: string;
  amount: number;
  currency: string;
  createdAt: Date | string;
  domains: Array<{
    domainName: string;
    itemType: string;
    price: number;
    registrationPeriod: number;
    periodUnit?: string;
    hostingPlan?: { name: string };
  }>;
  invoiceNumber?: string;
  invoiceProvider?: "primary" | "zoho";
  taxableValue?: number;
}

function makeOrder(over: Partial<FakeOrder> = {}): FakeOrder {
  return {
    orderId: "ORD-1",
    userId: "U1",
    amount: 1180,
    currency: "INR",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    domains: [
      { domainName: "x.com", itemType: "domain", price: 1000, registrationPeriod: 1, periodUnit: "years" },
    ],
    ...over,
  };
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  getOrderByIdOrOrderId.mockReset();
  getUserById.mockReset().mockResolvedValue(customer);
});

// ───────────────────────────────────────────────────────────────────
// Admin gate
// ───────────────────────────────────────────────────────────────────
describe("Admin gate", () => {
  it("no admin → 401 'Unauthorized'; NO order lookup", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(getOrderByIdOrOrderId).not.toHaveBeenCalled();
  });

  it("no admin → no user lookup either", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("admin present → proceeds past auth gate", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder());
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────
// No IDOR scoping — admin sees any order
// ───────────────────────────────────────────────────────────────────
describe("No IDOR scoping — admin can fetch any customer's order", () => {
  it("getOrderByIdOrOrderId called with just the order id (no user scope)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder());
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(getOrderByIdOrOrderId).toHaveBeenCalledWith("ORD-1");
    // Pinned: admin lookup is single-arg, NOT (id, adminId) — admin
    // is not restricted to their own orders.
    expect(getOrderByIdOrOrderId).not.toHaveBeenCalledWith("ORD-1", expect.anything());
  });

  it("fetches customer profile via order.userId (NOT admin._id)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder({ userId: "U-ALPHA" }));
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(getUserById).toHaveBeenCalledWith("U-ALPHA");
  });

  it("ObjectId-shaped order.userId is coerced to String for the customer lookup", async () => {
    const objId = { toString: () => "507f1f77bcf86cd799439099" };
    getOrderByIdOrOrderId.mockResolvedValueOnce(
      makeOrder({ userId: objId as unknown as string })
    );
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(getUserById).toHaveBeenCalledWith("507f1f77bcf86cd799439099");
  });
});

// ───────────────────────────────────────────────────────────────────
// Not-found paths
// ───────────────────────────────────────────────────────────────────
describe("Not-found paths", () => {
  it("order missing → 404 'Order not found' (no customer lookup)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-MISSING"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("order present but customer missing → 404 'Customer not found' (distinct from order 404)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder());
    getUserById.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Customer not found");
  });

  it("missing-customer 404 body is distinct from missing-order 404 body", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(null);
    const r1 = await GET(makeReq(), paramsOf("ORD-MISSING"));
    const b1 = await r1.json();

    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder());
    getUserById.mockResolvedValueOnce(null);
    const r2 = await GET(makeReq(), paramsOf("ORD-1"));
    const b2 = await r2.json();

    expect(b1.error).toBe("Order not found");
    expect(b2.error).toBe("Customer not found");
    expect(b1.error).not.toBe(b2.error);
  });
});

// ───────────────────────────────────────────────────────────────────
// Proforma path (no primary GST breakdown)
// ───────────────────────────────────────────────────────────────────
describe("Order without a primary GST breakdown → admin proforma PDF", () => {
  it("returns 200 with application/pdf", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder());
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("filename pattern Proforma-Admin-${orderId}.pdf (Admin suffix distinguishes from customer-side)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(
      makeOrder({ orderId: "ORD-7XY" })
    );
    const res = await GET(makeReq(), paramsOf("ORD-7XY"));
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Proforma-Admin-ORD-7XY.pdf"'
    );
  });

  it("primary provider but NO taxableValue → still a proforma (the breakdown is what makes it a tax invoice)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(
      makeOrder({ invoiceProvider: "primary", invoiceNumber: "TI/2026-27/00009" })
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Proforma-Admin-ORD-1.pdf"'
    );
  });

  it("renders even when customer.address is missing entirely", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder());
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      firstName: "Alice",
      lastName: "Doe",
      // no address, no companyName, no gstNumber
    });
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });

  it("renders with companyName + gstNumber present (full Bill-To block)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder());
    getUserById.mockResolvedValueOnce({
      ...customer,
      companyName: "Excel Tech",
      gstNumber: "07ABCDE1234F1Z5",
    });
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });

  it("handles hosting line items (uses hostingPlan.name)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(
      makeOrder({
        domains: [
          {
            domainName: "x.com",
            itemType: "hosting",
            price: 999,
            registrationPeriod: 1,
            periodUnit: "years",
            hostingPlan: { name: "Standard" },
          },
        ],
      })
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });

  it("handles hosting line items where hostingPlan is missing entirely", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(
      makeOrder({
        domains: [
          {
            domainName: "x.com",
            itemType: "hosting",
            price: 999,
            registrationPeriod: 1,
            periodUnit: "years",
            // no hostingPlan — uses "Service" fallback
          },
        ],
      })
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────
// Tax Invoice path + historical Zoho orders — both rendered locally
// ───────────────────────────────────────────────────────────────────
describe("Rendered locally for every provider", () => {
  it("primary order with taxableValue → Tax-Invoice filename (slashes → dashes)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(
      makeOrder({ invoiceProvider: "primary", invoiceNumber: "TI/2026-27/00001", taxableValue: 1000 })
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Tax-Invoice-TI-2026-27-00001.pdf"'
    );
  });

  it("**a historical Zoho-issued order renders a local proforma copy** — there is no Zoho to fetch from any more", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(
      makeOrder({ invoiceProvider: "zoho", invoiceNumber: "INV-000777" })
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Proforma-Admin-ORD-1.pdf"'
    );
  });

  it("the route source no longer imports a Zoho client (comments stripped first)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "app/api/admin/orders/[id]/invoice/route.ts"),
      "utf8"
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/zoho/i);
    expect(src).toContain("generateInvoicePdf(order, customer, { adminContext: true })");
  });
});

// ───────────────────────────────────────────────────────────────────
// Error handling
// ───────────────────────────────────────────────────────────────────
describe("Outer catch — generic 500, no leak", () => {
  it("getOrderByIdOrOrderId throw → 500 'Internal Server Error' (no leak)", async () => {
    getOrderByIdOrOrderId.mockRejectedValueOnce(
      new Error("Mongo timeout: secret-host-replica-1")
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(JSON.stringify(body)).not.toContain("secret-host-replica-1");
  });

  it("getUserById throw → 500 generic", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder());
    getUserById.mockRejectedValueOnce(new Error("UserDB blowup: leak-marker-A"));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(JSON.stringify(body)).not.toContain("leak-marker-A");
  });

  it("admin gate throw → 500 generic", async () => {
    getAdminFromRequest.mockRejectedValueOnce(
      new Error("Admin auth blowup: db-cred-leak-XYZ")
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(JSON.stringify(body)).not.toContain("db-cred-leak-XYZ");
  });
});

describe("REGRESSION (2026-09-03): accepts a user-facing orderId, not just a Mongo _id", () => {
  // This route used `getOrderById`, i.e. `Order.findById()` only. A
  // non-ObjectId id threw a Mongoose CastError -> caught -> 500.
  //
  // It became reachable when the admin invoices page grew its GST-engine tab
  // (9558706): a primary-engine invoice has no Zoho id, so its View and
  // Download link by the user-facing `orderId` string — and every single one
  // 500'd. Found by driving the real admin UI in a browser; the component
  // tests for that page mock the fetch, so they could not see it.
  it("**looks up by the string orderId the GST tab links with**", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder({ invoiceProvider: "primary", invoiceNumber: "TI/2026-27/00001", taxableValue: 1000 }));
    const res = await GET(makeReq(), paramsOf("ORD-RNW-1757000000-abcd"));
    expect(getOrderByIdOrOrderId).toHaveBeenCalledWith("ORD-RNW-1757000000-abcd");
    expect(res.status).toBe(200);
  });

  it("a primary-engine order renders the LOCAL pdf", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder({ invoiceProvider: "primary", invoiceNumber: "TI/2026-27/00001", taxableValue: 1000 }));
    const res = await GET(makeReq(), paramsOf("ORD-RNW-1757000000-abcd"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
  });

  it("still accepts a 24-hex Mongo _id (the pre-existing caller shape)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(makeOrder({ invoiceProvider: "primary", invoiceNumber: "TI/2026-27/00001", taxableValue: 1000 }));
    const hex = "68e5fd91602c8b9a2b12286d";
    await GET(makeReq(), paramsOf(hex));
    expect(getOrderByIdOrOrderId).toHaveBeenCalledWith(hex);
  });
});
