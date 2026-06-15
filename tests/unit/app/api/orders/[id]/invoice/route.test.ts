/**
 * Tests for `app/api/orders/[id]/invoice/route.ts` (slice 7i8, part 1).
 *
 * Customer-facing invoice PDF download. Two-path logic:
 *  - If order has `zohoInvoiceId` → fetch from Zoho Books. If Zoho
 *    returns null buffer → fall back to a locally-generated proforma
 *    PDF tagged "System is syncing your invoice. This is a proforma copy."
 *  - If no `zohoInvoiceId` → locally-generated proforma PDF.
 *
 * Pins:
 *  - **Dual auth**: JWT first (AuthService.getUserFromRequest), then
 *    NextAuth fallback via getToken. NextAuth path requires `isActive`
 *    unless `role === 'admin'` (deactivated-token defence).
 *  - **Anti-IDOR via findUserOrder(id, String(user._id))**: the second
 *    argument is the resolved user._id, NOT request data — so a
 *    customer can never pull another customer's invoice by id.
 *  - **Anti-enumeration 404 'Order not found'** on missing OR
 *    non-owner — the response is identical for "doesn't exist" and
 *    "not yours" (no side-channel via response shape).
 *  - **Zoho null buffer → fallback PDF** (NOT 500): when Zoho fetch
 *    fails, the customer still gets a usable proforma. Pinned with a
 *    probe asserting the proforma message in headers/disposition.
 *  - **Filename construction**:
 *    - Zoho path: `Invoice-${invoiceNumber || orderId}.pdf` (attachment)
 *    - Custom path: `Proforma-${orderId}.pdf` (attachment)
 *  - **Content-Type application/pdf** on all success paths.
 *  - **Outer catch → 500 'Internal Server Error' generic** — upstream
 *    error text (Zoho 401, Mongo timeout, etc.) NEVER reaches the
 *    client body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getToken = vi.hoisted(() => vi.fn());
vi.mock("next-auth/jwt", () => ({ getToken }));

vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET: "test-secret" }));

const findUserOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ findUserOrder }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const getInvoicePdf = vi.hoisted(() => vi.fn());
const getInstance = vi.hoisted(() => vi.fn(() => ({ getInvoicePdf })));
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: { getInstance },
}));

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

import { GET } from "@/app/api/orders/[id]/invoice/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/orders/ORD-1/invoice",
    { method: "GET" }
  );
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const user = {
  _id: "U1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Doe",
  isActive: true,
  address: { line1: "1 Test", city: "Delhi", state: "Delhi", zipcode: "110001", country: "IN" },
};

interface FakeOrder {
  orderId: string;
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
  zohoInvoiceId?: string;
}

function makeOrder(over: Partial<FakeOrder> = {}): FakeOrder {
  return {
    orderId: "ORD-1",
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
  getUserFromRequest.mockReset().mockResolvedValue(user);
  getToken.mockReset();
  getUserById.mockReset();
  findUserOrder.mockReset();
  getInvoicePdf.mockReset();
  getInstance.mockClear();
});

// ───────────────────────────────────────────────────────────────────
// Dual auth
// ───────────────────────────────────────────────────────────────────
describe("Dual auth — JWT first, NextAuth fallback", () => {
  it("JWT user → proceeds; NextAuth getToken NOT consulted", async () => {
    findUserOrder.mockResolvedValueOnce(makeOrder());
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("no JWT → falls through to NextAuth; valid token + active user → 200", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U1" });
    getUserById.mockResolvedValueOnce({ ...user });
    findUserOrder.mockResolvedValueOnce(makeOrder());
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });

  it("no JWT + no NextAuth token → 401 'Unauthorized'", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValue(null);
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(findUserOrder).not.toHaveBeenCalled();
  });

  it("NextAuth token + INACTIVE non-admin → 401 (token validity alone insufficient)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U1" });
    getUserById.mockResolvedValueOnce({ ...user, isActive: false, role: "user" });
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    expect(findUserOrder).not.toHaveBeenCalled();
  });

  it("NextAuth token + INACTIVE but role=admin → STILL allowed (admin escape hatch)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U1" });
    getUserById.mockResolvedValueOnce({ ...user, isActive: false, role: "admin" });
    findUserOrder.mockResolvedValueOnce(makeOrder());
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });

  it("NextAuth token but getUserById returns null → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U1" });
    getUserById.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
  });

  it("NextAuth token without an id → falls through to final unauth check; 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({});
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    expect(getUserById).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────
// IDOR scoping
// ───────────────────────────────────────────────────────────────────
describe("Anti-IDOR — findUserOrder scoped on user._id", () => {
  it("called with (id, String(user._id)) — second arg pinned to the auth user", async () => {
    findUserOrder.mockResolvedValueOnce(makeOrder());
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(findUserOrder).toHaveBeenCalledWith("ORD-1", "U1");
  });

  it("ObjectId-shaped user._id is coerced to String for the lookup", async () => {
    const objId = { toString: () => "507f1f77bcf86cd799439011" };
    getUserFromRequest.mockResolvedValueOnce({ ...user, _id: objId });
    findUserOrder.mockResolvedValueOnce(makeOrder());
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(findUserOrder).toHaveBeenCalledWith("ORD-1", "507f1f77bcf86cd799439011");
  });

  it("non-owner / not-found → 404 'Order not found' (ambiguous)", async () => {
    findUserOrder.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-999"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
  });

  it("ambiguity guarantee: response for 'does-not-exist' is byte-identical to 'not-yours'", async () => {
    findUserOrder.mockResolvedValueOnce(null);
    const r1 = await GET(makeReq(), paramsOf("DOES-NOT-EXIST"));
    const b1 = await r1.json();
    findUserOrder.mockResolvedValueOnce(null);
    const r2 = await GET(makeReq(), paramsOf("OTHER-CUSTOMER-ORDER"));
    const b2 = await r2.json();
    expect(r1.status).toBe(r2.status);
    expect(b1).toEqual(b2);
  });

  it("Zoho is NOT called when order lookup returns null", async () => {
    findUserOrder.mockResolvedValueOnce(null);
    await GET(makeReq(), paramsOf("ORD-999"));
    expect(getInvoicePdf).not.toHaveBeenCalled();
    expect(getInstance).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────
// No-Zoho path: custom proforma
// ───────────────────────────────────────────────────────────────────
describe("No zohoInvoiceId → custom proforma PDF", () => {
  it("returns 200 with application/pdf Content-Type", async () => {
    findUserOrder.mockResolvedValueOnce(makeOrder({ zohoInvoiceId: undefined }));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("filename pattern Proforma-${orderId}.pdf as attachment", async () => {
    findUserOrder.mockResolvedValueOnce(makeOrder({ orderId: "ORD-ALPHA", zohoInvoiceId: undefined }));
    const res = await GET(makeReq(), paramsOf("ORD-ALPHA"));
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Proforma-ORD-ALPHA.pdf"'
    );
  });

  it("empty-string zohoInvoiceId still triggers proforma (falsy)", async () => {
    findUserOrder.mockResolvedValueOnce(makeOrder({ zohoInvoiceId: "" }));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(getInvoicePdf).not.toHaveBeenCalled();
  });

  it("Zoho NOT consulted when zohoInvoiceId is missing", async () => {
    findUserOrder.mockResolvedValueOnce(makeOrder({ zohoInvoiceId: undefined }));
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(getInstance).not.toHaveBeenCalled();
    expect(getInvoicePdf).not.toHaveBeenCalled();
  });

  it("proforma generator does not crash when address fields are missing", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U1",
      firstName: "Alice",
      lastName: "Doe",
      // no address, no companyName, no gstNumber
    });
    findUserOrder.mockResolvedValueOnce(makeOrder({ zohoInvoiceId: undefined }));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });

  it("proforma generator handles hosting line items (different title prefix)", async () => {
    findUserOrder.mockResolvedValueOnce(
      makeOrder({
        zohoInvoiceId: undefined,
        domains: [
          {
            domainName: "x.com",
            itemType: "hosting",
            price: 999,
            registrationPeriod: 1,
            periodUnit: "years",
            hostingPlan: { name: "Starter" },
          },
        ],
      })
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });

  it("proforma generator handles multiple domain items", async () => {
    findUserOrder.mockResolvedValueOnce(
      makeOrder({
        zohoInvoiceId: undefined,
        domains: [
          { domainName: "a.com", itemType: "domain", price: 800, registrationPeriod: 1 },
          { domainName: "b.com", itemType: "domain", price: 900, registrationPeriod: 1 },
          { domainName: "c.com", itemType: "domain", price: 1000, registrationPeriod: 1 },
        ],
      })
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────
// Zoho path: real PDF
// ───────────────────────────────────────────────────────────────────
describe("Zoho path — real invoice PDF", () => {
  it("returns Zoho buffer as-is with application/pdf", async () => {
    findUserOrder.mockResolvedValueOnce(
      makeOrder({ zohoInvoiceId: "ZINV-7", invoiceNumber: "INV/2026/123" })
    );
    getInvoicePdf.mockResolvedValueOnce(new ArrayBuffer(32));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("filename uses invoiceNumber when present", async () => {
    findUserOrder.mockResolvedValueOnce(
      makeOrder({ zohoInvoiceId: "ZINV-7", invoiceNumber: "INV/2026/123" })
    );
    getInvoicePdf.mockResolvedValueOnce(new ArrayBuffer(32));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Invoice-INV/2026/123.pdf"'
    );
  });

  it("filename falls back to orderId when invoiceNumber is missing", async () => {
    findUserOrder.mockResolvedValueOnce(
      makeOrder({ zohoInvoiceId: "ZINV-7", invoiceNumber: undefined })
    );
    getInvoicePdf.mockResolvedValueOnce(new ArrayBuffer(32));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Invoice-ORD-1.pdf"'
    );
  });

  it("Zoho service is looked up exactly once via getInstance singleton", async () => {
    findUserOrder.mockResolvedValueOnce(
      makeOrder({ zohoInvoiceId: "ZINV-7" })
    );
    getInvoicePdf.mockResolvedValueOnce(new ArrayBuffer(8));
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(getInstance).toHaveBeenCalledTimes(1);
    expect(getInvoicePdf).toHaveBeenCalledWith("ZINV-7");
  });

  it("Zoho null buffer → falls back to custom proforma (NOT 500)", async () => {
    findUserOrder.mockResolvedValueOnce(
      makeOrder({ zohoInvoiceId: "ZINV-7" })
    );
    getInvoicePdf.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Proforma-ORD-1.pdf"'
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// Error handling
// ───────────────────────────────────────────────────────────────────
describe("Outer catch — generic 500, no leak", () => {
  it("findUserOrder throw → 500 'Internal Server Error' (no leak of upstream error)", async () => {
    findUserOrder.mockRejectedValueOnce(new Error("Mongo timeout: connection refused at host"));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(JSON.stringify(body)).not.toContain("Mongo timeout");
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });

  it("Zoho throw → 500 generic (no zoho fragment leak)", async () => {
    findUserOrder.mockResolvedValueOnce(
      makeOrder({ zohoInvoiceId: "ZINV-7" })
    );
    getInvoicePdf.mockRejectedValueOnce(
      new Error("ZohoBooks 401 invalid_token: access_token expired")
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(JSON.stringify(body)).not.toContain("access_token");
    expect(JSON.stringify(body)).not.toContain("invalid_token");
  });

  it("getUserById throw on NextAuth path → 500 generic", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U1" });
    getUserById.mockRejectedValueOnce(new Error("UserById DB error: secret-host-leak"));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(JSON.stringify(body)).not.toContain("secret-host-leak");
  });
});
