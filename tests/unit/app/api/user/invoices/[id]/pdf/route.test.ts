/**
 * Tests for `app/api/user/invoices/[id]/pdf/route.ts` (slice 7gz,
 * part 2). Customer downloads one of their own invoice PDFs.
 *
 * Pins:
 *  - Auth → 401 'Unauthorized'
 *  - **Per-user rate limit** keyed `pdf_invoice:${user._id}` against
 *    the pdfInvoice limiter (10/min); over-limit → rateLimitResponse
 *    with that limit + 'Too many requests' message (NO Zoho call,
 *    NO DB lookup)
 *  - **Sentinel-id guard**: ids 'pending_creation' and
 *    'creation_failed' → 404 'Invoice not available'. These are
 *    written by the invoice-creation flow when Zoho is unreachable;
 *    they're NOT real Zoho invoice IDs, so the route refuses to
 *    even try the Zoho call.
 *  - **IDOR via findOrderByZohoInvoiceForUser(user._id, id,
 *    {select:'_id'})** — Mongo lookup runs BEFORE the Zoho call
 *    (anti-Zoho-enumeration; saves a Zoho round-trip on bad IDs);
 *    field allow-list `select:'_id'` pinned (minimal projection —
 *    no order data needed for this gate)
 *  - Non-owner → **403 'Forbidden: You do not have access to this
 *    invoice'** (NOT 404 — distinct from sentinel-id 404 because
 *    here the invoice DOES exist; the user just doesn't own it,
 *    and the security-warn log records the attempt)
 *  - Zoho null buffer → 500 'Failed to generate PDF'
 *  - **Binary PDF response with INLINE disposition** (NOT
 *    attachment): Content-Type application/pdf; Content-Disposition
 *    `inline; filename="Invoice-${id}.pdf"`. Inline = render in
 *    browser (anti-forced-download); pinned because changing to
 *    `attachment` would surprise users who tap a link.
 *  - Outer catch → 500 'Internal Server Error' generic (Zoho leak
 *    guarded)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const checkKey = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { pdfInvoice: { checkKey } },
  rateLimitResponse,
}));

const findOrderByZohoInvoiceForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ findOrderByZohoInvoiceForUser }));

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

import { GET } from "@/app/api/user/invoices/[id]/pdf/route";

function makeReq() {
  return new NextRequest("https://example.com/api/user/invoices/INV-1/pdf", {
    method: "GET",
  });
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  checkKey.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
  findOrderByZohoInvoiceForUser.mockReset();
  getInvoicePdf.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401 'Unauthorized'; NO rate-limit check", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(401);
    expect(checkKey).not.toHaveBeenCalled();
  });
});

describe("Per-user rate limit", () => {
  it("checkKey called with `pdf_invoice:${user._id}`", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoicePdf.mockResolvedValueOnce(Buffer.from("%PDF-1.7 fake"));
    await GET(makeReq(), paramsOf("INV-1"));
    expect(checkKey).toHaveBeenCalledWith("pdf_invoice:U1");
  });

  it("over limit → rateLimitResponse with limit:10 + 'Too many'; NO Zoho call, NO DB lookup", async () => {
    checkKey.mockResolvedValueOnce({ allowed: false });
    const rlRes = new Response("rate-limited", { status: 429 });
    rateLimitResponse.mockReturnValueOnce(rlRes);

    const res = await GET(makeReq(), paramsOf("INV-1"));
    expect(res).toBe(rlRes);
    expect(rateLimitResponse).toHaveBeenCalledWith(
      { allowed: false },
      {
        limit: 10,
        message: "Too many requests. Please wait before downloading again.",
      }
    );
    expect(findOrderByZohoInvoiceForUser).not.toHaveBeenCalled();
    expect(getInvoicePdf).not.toHaveBeenCalled();
  });
});

describe("Sentinel-id guard", () => {
  it.each(["pending_creation", "creation_failed"])(
    "id = %p → 404 'Invoice not available'; NO DB lookup, NO Zoho call",
    async (id) => {
      const res = await GET(makeReq(), paramsOf(id));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Invoice not available");
      expect(findOrderByZohoInvoiceForUser).not.toHaveBeenCalled();
      expect(getInvoicePdf).not.toHaveBeenCalled();
    }
  );
});

describe("IDOR via MongoDB before Zoho", () => {
  it("findOrderByZohoInvoiceForUser called with (user._id, id, {select:'_id'}) — minimal projection pinned", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce(null);
    await GET(makeReq(), paramsOf("INV-OTHER-USER"));
    expect(findOrderByZohoInvoiceForUser).toHaveBeenCalledWith(
      "U1",
      "INV-OTHER-USER",
      { select: "_id" }
    );
  });

  it("non-owner → 403 'Forbidden: You do not have access to this invoice' (NOT 404, distinct from sentinel-id); NO Zoho call", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("INV-OTHER-USER"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Forbidden");
    expect(body.error).toContain("do not have access");
    expect(getInvoicePdf).not.toHaveBeenCalled();
  });
});

describe("Zoho PDF fetch", () => {
  it("calls getInvoicePdf with the URL-param id", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoicePdf.mockResolvedValueOnce(Buffer.from("%PDF-1.7"));
    await GET(makeReq(), paramsOf("INV-CUSTOMER-A"));
    expect(getInvoicePdf).toHaveBeenCalledWith("INV-CUSTOMER-A");
  });

  it("null buffer → 500 'Failed to generate PDF'", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoicePdf.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to generate PDF");
  });
});

describe("Success — binary PDF response with INLINE disposition", () => {
  it("Content-Type pdf; Content-Disposition `inline; filename=...`; raw Buffer body", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    const pdfBytes = Buffer.from("%PDF-1.7 a real PDF goes here");
    getInvoicePdf.mockResolvedValueOnce(pdfBytes);

    const res = await GET(makeReq(), paramsOf("INV-77"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="Invoice-INV-77.pdf"'
    );

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("inline (NOT attachment) — pinned because attachment forces a download dialog the user didn't ask for", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoicePdf.mockResolvedValueOnce(Buffer.from("%PDF"));
    const res = await GET(makeReq(), paramsOf("INV-1"));
    const cd = res.headers.get("content-disposition")!;
    expect(cd.startsWith("inline;")).toBe(true);
    expect(cd).not.toContain("attachment");
  });
});

describe("Outer catch", () => {
  it("findOrderByZohoInvoiceForUser throw → 500 'Internal Server Error' (Zoho leak guarded)", async () => {
    findOrderByZohoInvoiceForUser.mockRejectedValueOnce(
      new Error("Mongo: shard-2 connection refused with apk_zoho_TOKEN_LEAK")
    );
    const res = await GET(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(body.error).not.toContain("Mongo");
    expect(body.error).not.toContain("apk_zoho_TOKEN_LEAK");
  });

  it("Zoho throw → 500 generic", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoicePdf.mockRejectedValueOnce(
      new Error("Zoho 401: access_token=zoho_LEAK")
    );
    const res = await GET(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(body.error).not.toContain("zoho_LEAK");
    expect(body.error).not.toContain("access_token");
  });
});
