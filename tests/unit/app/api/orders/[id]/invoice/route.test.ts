/**
 * Tests for `app/api/orders/[id]/invoice/route.ts` (slice 7i8, part 1).
 *
 * Customer-facing invoice PDF download. Since Zoho Books was removed
 * (24 Sep 2026) there is ONE path: generateInvoicePdf from the order. A
 * primary-engine order with its GST breakdown renders as a Tax Invoice;
 * anything else — including a historical `invoiceProvider: 'zoho'`
 * order — renders as a Proforma copy.
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
 *  - **Filename construction**:
 *    - Tax Invoice: `Tax-Invoice-${invoiceNumber, / → -}.pdf`
 *    - Proforma: `Proforma-${orderId}.pdf` (attachment)
 *  - **Content-Type application/pdf** on all success paths.
 *  - **Outer catch → 500 'Internal Server Error' generic** — upstream
 *    error text (Mongo timeout, etc.) NEVER reaches the
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
  invoiceProvider?: "primary" | "zoho";
  taxableValue?: number;
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

  it("no PDF is rendered when order lookup returns null (JSON 404, not a PDF)", async () => {
    findUserOrder.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-999"));
    expect(res.headers.get("Content-Type")).not.toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────
// Proforma path (no primary GST breakdown)
// ───────────────────────────────────────────────────────────────────
describe("Order without a primary GST breakdown → proforma PDF", () => {
  it("returns 200 with application/pdf Content-Type", async () => {
    findUserOrder.mockResolvedValueOnce(makeOrder());
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("filename pattern Proforma-${orderId}.pdf as attachment", async () => {
    findUserOrder.mockResolvedValueOnce(makeOrder({ orderId: "ORD-ALPHA" }));
    const res = await GET(makeReq(), paramsOf("ORD-ALPHA"));
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Proforma-ORD-ALPHA.pdf"'
    );
  });

  it("primary provider but NO taxableValue → still a proforma", async () => {
    findUserOrder.mockResolvedValueOnce(
      makeOrder({ invoiceProvider: "primary", invoiceNumber: "TI/2026-27/00009" })
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Proforma-ORD-1.pdf"'
    );
  });

  it("proforma generator does not crash when address fields are missing", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U1",
      firstName: "Alice",
      lastName: "Doe",
      // no address, no companyName, no gstNumber
    });
    findUserOrder.mockResolvedValueOnce(makeOrder());
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
  });

  it("proforma generator handles hosting line items (different title prefix)", async () => {
    findUserOrder.mockResolvedValueOnce(
      makeOrder({
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
// Tax Invoice path + historical Zoho orders — both rendered locally
// ───────────────────────────────────────────────────────────────────
describe("Rendered locally for every provider", () => {
  it("primary order with taxableValue → Tax-Invoice filename (slashes → dashes)", async () => {
    findUserOrder.mockResolvedValueOnce(
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
    findUserOrder.mockResolvedValueOnce(
      makeOrder({ invoiceProvider: "zoho", invoiceNumber: "INV-000123" })
    );
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Proforma-ORD-1.pdf"'
    );
  });

  it("the route source no longer references Zoho (comments stripped first)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "app/api/orders/[id]/invoice/route.ts"),
      "utf8"
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/zoho/i);
    expect(src).toContain("generateInvoicePdf(order, user)");
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
