/**
 * Tests for `app/api/admin/invoices/[id]/pdf/route.ts` (slice 7gt,
 * part 1). Admin downloads a customer invoice PDF (binary
 * response, not JSON).
 *
 * Pins:
 *  - **Missing id → 400 BEFORE connectDB or auth** (id gate is
 *    cheapest, runs first)
 *  - connectDB BEFORE auth (current source order)
 *  - Admin gate via getAdminFromRequest → 401
 *  - ZohoBooksService.getInstance().getInvoicePdf(invoiceId)
 *  - null buffer → 404 'Failed to fetch PDF from Zoho'
 *  - **Success response is BINARY, not JSON**: Content-Type
 *    application/pdf; Content-Disposition `attachment;
 *    filename="Invoice-${invoiceId}.pdf"` with invoiceId
 *    interpolated; body is the raw Buffer
 *  - Outer catch → 500 'Failed to download invoice' (no leak —
 *    Zoho exceptions can carry tokens)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const getInvoicePdf = vi.hoisted(() => vi.fn());
const getInstance = vi.hoisted(() => vi.fn(() => ({ getInvoicePdf })));
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: { getInstance },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/invoices/[id]/pdf/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/admin/invoices/INV-1/pdf",
    { method: "GET" }
  );
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  getAdminFromRequest.mockReset();
  connectDB.mockClear().mockResolvedValue(undefined);
  getInvoicePdf.mockReset();
});

describe("Id gate (cheapest, runs first)", () => {
  it("empty id → 400 'Invoice ID required' BEFORE connectDB or auth", async () => {
    const res = await GET(makeReq(), paramsOf(""));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invoice ID required");
    expect(connectDB).not.toHaveBeenCalled();
    expect(getAdminFromRequest).not.toHaveBeenCalled();
    expect(getInvoicePdf).not.toHaveBeenCalled();
  });
});

describe("Admin gate (after connectDB)", () => {
  it("non-admin → 401 'Unauthorized'; NO Zoho PDF fetch", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(connectDB).toHaveBeenCalled();
    expect(getInvoicePdf).not.toHaveBeenCalled();
  });
});

describe("Zoho PDF fetch", () => {
  it("getInvoicePdf called with the invoice id from the route", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1", email: "admin@x.com" });
    getInvoicePdf.mockResolvedValueOnce(Buffer.from("%PDF-1.7 fake"));
    await GET(makeReq(), paramsOf("INV-CUSTOM-12345"));
    expect(getInvoicePdf).toHaveBeenCalledWith("INV-CUSTOM-12345");
  });

  it("null buffer → 404 'Failed to fetch PDF from Zoho'", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getInvoicePdf.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch PDF from Zoho");
  });
});

describe("Success response is BINARY (PDF), not JSON", () => {
  it("returns Buffer body with PDF headers and invoice-id-interpolated filename", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    const pdfBytes = Buffer.from("%PDF-1.7 totally real PDF");
    getInvoicePdf.mockResolvedValueOnce(pdfBytes);

    const res = await GET(makeReq(), paramsOf("INV-9876"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Invoice-INV-9876.pdf"'
    );

    // Body is the raw bytes, not a JSON wrapper
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });
});

describe("Outer catch — no leak", () => {
  it("Zoho throw → 500 'Failed to download invoice' (Zoho org/token strings NOT leaked)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getInvoicePdf.mockRejectedValueOnce(
      new Error("Zoho 401: access_token=zoho_oauth_LEAK invalid")
    );
    const res = await GET(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to download invoice");
    expect(body.error).not.toContain("zoho_oauth_LEAK");
    expect(body.error).not.toContain("access_token");
  });

  it("connectDB throw → 500 'Failed to download invoice'", async () => {
    connectDB.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to download invoice");
  });
});
