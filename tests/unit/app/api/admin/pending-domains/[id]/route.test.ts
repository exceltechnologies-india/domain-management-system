/**
 * Tests for `app/api/admin/pending-domains/[id]/route.ts`
 * (rescan-4 slice 7g4). Admin-only GET + PUT + DELETE for pending-
 * domain rows that didn't auto-register. Coordinates registrar
 * cancellation + Order-collection sync + failure-email notifications.
 *
 * Pins:
 *  - **All 3 handlers gate on AuthService.getAdminFromRequest** (NOT
 *    getUserFromRequest — admin-only); null → 401 'Unauthorized'
 *    (no DB lookup, no RC call, no email)
 *  - **GET**: getPendingDomainById(id, {populateUser:true}); null →
 *    404; happy path returns {success, pendingDomain}
 *  - **PUT schema**: status enum (pending/processing/failed/
 *    completed), adminNotes max 5000, reason max 2000
 *  - **PUT field assignment**: each field updated only if defined;
 *    pendingDomain.save() once
 *  - **PUT order sync H1 fix**: status='completed' → order.domains
 *    [i].status='registered'; ANY OTHER status → 'failed' (legacy
 *    code compared against 'registered' which never matched — every
 *    sync silently fell through to 'failed' even when admin marked
 *    completed; fixed by mapping completed→registered)
 *  - **PUT order sync**: reason copied to order.domains[i].error
 *    when status='failed'; bookingStatus appended (step
 *    'domain_registered'/'domain_failed', progress 100/0)
 *  - **PUT order sync failure SWALLOWED** (pending domain still
 *    updated — admin action shouldn't fail because of bookkeeping)
 *  - **DELETE permanent vs soft-archive fork**: ?permanent=true →
 *    RC cancel + deleteOne + Domain cleanup; else → archive
 *    (findOneAndUpdate isArchived/archivedAt/archivedBy/status:'failed')
 *  - **DELETE permanent — RC orderId fallback search**: if
 *    resellerClubOrderId missing on row, rcGetDomainOrderId by
 *    domainName as safety net
 *  - **DELETE permanent — RC cancel result mapping**: status=
 *    'success' → registrarCancelled:true; else → message captured
 *    but deletion proceeds (registrar might be unreachable; local
 *    state must converge anyway)
 *  - **DELETE permanent — Domain.deleteMany cleanup** (removes any
 *    premature Domain records for this {domainName, orderId})
 *  - **DELETE archive — order sync**: order.domains[i].status='failed';
 *    error stamped with reason; bookingStatus appended; Domain.
 *    deleteMany cleanup also runs in archive path
 *  - **DELETE archive — failure email**: sendPurchaseOrderEmail
 *    called when customer.email present; isFirstTime flag set from
 *    paymentWasSuccessful (registrationFailed=true after successful
 *    payment)
 *  - **DELETE archive — email failure SWALLOWED**
 *  - **DELETE outer catch** → 500 with `Failed to process pending
 *    domain: ${message}` (exposes specific message to admin UI)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const getPendingDomainById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-domains", () => ({ getPendingDomainById }));

const getOrderByOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ getOrderByOrderId }));

const pendingDomainDeleteOne = vi.hoisted(() => vi.fn());
const pendingDomainFindOneAndUpdate = vi.hoisted(() => vi.fn());
vi.mock("@/models/PendingDomain", () => ({
  default: {
    deleteOne: pendingDomainDeleteOne,
    findOneAndUpdate: pendingDomainFindOneAndUpdate,
  },
}));

const domainDeleteMany = vi.hoisted(() => vi.fn());
vi.mock("@/models/Domain", () => ({
  default: { deleteMany: domainDeleteMany },
}));

const deleteDomainOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { deleteDomainOrder },
}));

const rcGetDomainOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/resellerclub", () => ({
  getDomainOrderId: rcGetDomainOrderId,
}));

const sendPurchaseOrderEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendPurchaseOrderEmail },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mongooseIsObjectIdValid, FakeObjectId } = vi.hoisted(() => {
  const isValid = vi.fn(() => true);
  class FakeObjectId {
    constructor(public id: string) {}
    static isValid = isValid;
  }
  return { mongooseIsObjectIdValid: isValid, FakeObjectId };
});
vi.mock("mongoose", () => ({
  default: { Types: { ObjectId: FakeObjectId } },
  Types: { ObjectId: FakeObjectId },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import {
  GET,
  PUT,
  DELETE,
} from "@/app/api/admin/pending-domains/[id]/route";

// ── helpers ──────────────────────────────────────────────────────────
function makeReq(
  method: "GET" | "PUT" | "DELETE",
  opts: { body?: unknown; query?: string } = {}
) {
  const url = `https://example.com/api/admin/pending-domains/PD1${
    opts.query ? "?" + opts.query : ""
  }`;
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makePendingDomain(overrides: Partial<any> = {}) {
  return {
    _id: "PD1",
    domainName: "ex.com",
    orderId: "ORD-1",
    resellerClubOrderId: "RC-99",
    status: "pending",
    adminNotes: "",
    reason: "",
    price: 999,
    registrationPeriod: 1,
    userId: { email: "u@x.com", firstName: "First", lastName: "Last" },
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeOrder(overrides: Partial<any> = {}): any {
  return {
    orderId: "ORD-1",
    status: "completed",
    amount: 1180,
    currency: "INR",
    paymentVerification: { paymentStatus: "success" },
    purchaseOrderNumber: "PO-1",
    invoiceNumber: "INV-1",
    paymentId: "pay_1",
    createdAt: new Date("2026-01-01"),
    domains: [
      {
        domainName: "ex.com",
        status: "pending",
        bookingStatus: [],
      },
    ],
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const admin = { _id: "A1", email: "admin@x.com", role: "admin" };

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  connectDB.mockReset().mockResolvedValue(undefined);
  getPendingDomainById.mockReset();
  getOrderByOrderId.mockReset();
  pendingDomainDeleteOne.mockReset().mockResolvedValue(undefined);
  pendingDomainFindOneAndUpdate.mockReset().mockResolvedValue(undefined);
  domainDeleteMany.mockReset().mockResolvedValue({ deletedCount: 0 });
  deleteDomainOrder.mockReset();
  rcGetDomainOrderId.mockReset();
  sendPurchaseOrderEmail.mockReset().mockResolvedValue(undefined);
  mongooseIsObjectIdValid.mockReset().mockReturnValue(true);
});

// ─── Admin gates on all 3 handlers ─────────────────────────────────
describe("Admin auth gate (all 3 handlers)", () => {
  it("GET no admin → 401 (no DB lookup)", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"), paramsOf("PD1"));
    expect(res.status).toBe(401);
    expect(getPendingDomainById).not.toHaveBeenCalled();
  });

  it("PUT no admin → 401 (no DB lookup)", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await PUT(
      makeReq("PUT", { body: { status: "completed" } }),
      paramsOf("PD1")
    );
    expect(res.status).toBe(401);
    expect(getPendingDomainById).not.toHaveBeenCalled();
  });

  it("DELETE no admin → 401 (no RC cancel, no DB delete)", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq("DELETE"), paramsOf("PD1"));
    expect(res.status).toBe(401);
    expect(deleteDomainOrder).not.toHaveBeenCalled();
    expect(pendingDomainDeleteOne).not.toHaveBeenCalled();
  });
});

// ─── GET ────────────────────────────────────────────────────────────
describe("GET — pending domain fetch", () => {
  it("not found → 404", async () => {
    getPendingDomainById.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"), paramsOf("PD1"));
    expect(res.status).toBe(404);
  });

  it("found → 200 with pendingDomain payload + populateUser:true", async () => {
    const pd = makePendingDomain();
    getPendingDomainById.mockResolvedValueOnce(pd);
    const res = await GET(makeReq("GET"), paramsOf("PD1"));
    expect(res.status).toBe(200);
    expect(getPendingDomainById).toHaveBeenCalledWith("PD1", {
      populateUser: true,
    });
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("outer catch → 500", async () => {
    getPendingDomainById.mockRejectedValueOnce(new Error("DB outage"));
    const res = await GET(makeReq("GET"), paramsOf("PD1"));
    expect(res.status).toBe(500);
  });
});

// ─── PUT ────────────────────────────────────────────────────────────
describe("PUT — schema validation", () => {
  it("invalid status enum → schema rejection", async () => {
    const res = await PUT(
      makeReq("PUT", { body: { status: "weird" } }),
      paramsOf("PD1")
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("adminNotes > 5000 chars → rejection", async () => {
    const res = await PUT(
      makeReq("PUT", { body: { adminNotes: "x".repeat(5001) } }),
      paramsOf("PD1")
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("PUT — not found", () => {
  it("getPendingDomainById null → 404", async () => {
    getPendingDomainById.mockResolvedValueOnce(null);
    const res = await PUT(
      makeReq("PUT", { body: { status: "completed" } }),
      paramsOf("PD1")
    );
    expect(res.status).toBe(404);
  });
});

describe("PUT — field updates", () => {
  it("status update assigned and saved", async () => {
    const pd = makePendingDomain();
    getPendingDomainById.mockResolvedValueOnce(pd);
    await PUT(
      makeReq("PUT", { body: { status: "completed" } }),
      paramsOf("PD1")
    );
    expect(pd.status).toBe("completed");
    expect(pd.save).toHaveBeenCalled();
  });

  it("adminNotes undefined → NOT written (each field gated)", async () => {
    const pd = makePendingDomain({ adminNotes: "existing" });
    getPendingDomainById.mockResolvedValueOnce(pd);
    await PUT(
      makeReq("PUT", { body: { status: "completed" } }),
      paramsOf("PD1")
    );
    expect(pd.adminNotes).toBe("existing"); // unchanged
  });

  it("reason updated when provided", async () => {
    const pd = makePendingDomain();
    getPendingDomainById.mockResolvedValueOnce(pd);
    await PUT(
      makeReq("PUT", { body: { reason: "TLD restricted" } }),
      paramsOf("PD1")
    );
    expect(pd.reason).toBe("TLD restricted");
  });
});

describe("PUT — order-sync H1 fix (completed → 'registered')", () => {
  it("status='completed' → order domain status='registered'; bookingStatus step 'domain_registered' progress 100", async () => {
    const pd = makePendingDomain();
    const order = makeOrder();
    getPendingDomainById.mockResolvedValueOnce(pd);
    getOrderByOrderId.mockResolvedValueOnce(order);

    await PUT(
      makeReq("PUT", { body: { status: "completed" } }),
      paramsOf("PD1")
    );

    expect(order.domains[0].status).toBe("registered");
    const lastBs =
      order.domains[0].bookingStatus[order.domains[0].bookingStatus.length - 1];
    expect(lastBs.step).toBe("domain_registered");
    expect(lastBs.progress).toBe(100);
    expect(order.save).toHaveBeenCalled();
  });

  it("status='failed' → order domain status='failed'; bookingStatus step 'domain_failed' progress 0", async () => {
    const pd = makePendingDomain();
    const order = makeOrder();
    getPendingDomainById.mockResolvedValueOnce(pd);
    getOrderByOrderId.mockResolvedValueOnce(order);

    await PUT(
      makeReq("PUT", {
        body: { status: "failed", reason: "Registry rejected" },
      }),
      paramsOf("PD1")
    );

    expect(order.domains[0].status).toBe("failed");
    expect(order.domains[0].error).toBe("Registry rejected");
    const lastBs =
      order.domains[0].bookingStatus[order.domains[0].bookingStatus.length - 1];
    expect(lastBs.step).toBe("domain_failed");
    expect(lastBs.progress).toBe(0);
  });

  it("status='processing' (NON-completed) → order domain status='failed' (per the source's binary map)", async () => {
    const pd = makePendingDomain();
    const order = makeOrder();
    getPendingDomainById.mockResolvedValueOnce(pd);
    getOrderByOrderId.mockResolvedValueOnce(order);

    await PUT(
      makeReq("PUT", { body: { status: "processing" } }),
      paramsOf("PD1")
    );

    expect(order.domains[0].status).toBe("failed");
  });

  it("matching domain NOT found in order.domains → no order mutation", async () => {
    const pd = makePendingDomain({ domainName: "other.com" });
    const order = makeOrder(); // has 'ex.com' only
    getPendingDomainById.mockResolvedValueOnce(pd);
    getOrderByOrderId.mockResolvedValueOnce(order);

    await PUT(
      makeReq("PUT", { body: { status: "completed" } }),
      paramsOf("PD1")
    );

    expect(order.save).not.toHaveBeenCalled();
  });
});

describe("PUT — order sync resilience", () => {
  it("getOrderByOrderId throw → response still 200 (sync error swallowed)", async () => {
    const pd = makePendingDomain();
    getPendingDomainById.mockResolvedValueOnce(pd);
    getOrderByOrderId.mockRejectedValueOnce(new Error("DB outage"));

    const res = await PUT(
      makeReq("PUT", { body: { status: "completed" } }),
      paramsOf("PD1")
    );
    expect(res.status).toBe(200);
  });

  it("no orderId on pendingDomain → skips sync (no getOrderByOrderId call)", async () => {
    const pd = makePendingDomain({ orderId: undefined });
    getPendingDomainById.mockResolvedValueOnce(pd);

    await PUT(
      makeReq("PUT", { body: { status: "completed" } }),
      paramsOf("PD1")
    );

    expect(getOrderByOrderId).not.toHaveBeenCalled();
  });
});

describe("PUT — outer catch", () => {
  it("getPendingDomainById throw → 500 'Failed to update'", async () => {
    getPendingDomainById.mockRejectedValueOnce(new Error("DB down"));
    const res = await PUT(
      makeReq("PUT", { body: { status: "completed" } }),
      paramsOf("PD1")
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update pending domain");
  });
});

// ─── DELETE — permanent branch ─────────────────────────────────────
describe("DELETE — permanent branch (?permanent=true)", () => {
  // Note: NO default value — explicit-undefined passing must produce a
  // pendingDomain with rcOrderId truly absent, exercising the fallback
  // search path. A default of 'RC-99' would mask the test intent.
  function setupPendingWithOrderId(rcOrderId: string | undefined) {
    // Permanent delete is only allowed on an ARCHIVED row (archive-first
    // flow), so the fixtures for the happy paths must be archived.
    const pd = makePendingDomain({ resellerClubOrderId: rcOrderId, isArchived: true });
    getPendingDomainById.mockResolvedValueOnce(pd);
    return pd;
  }

  it("not found → 404", async () => {
    getPendingDomainById.mockResolvedValueOnce(null);
    const res = await DELETE(
      makeReq("DELETE", { query: "permanent=true" }),
      paramsOf("PD1")
    );
    expect(res.status).toBe(404);
  });

  it("non-archived row → 400 archive-first guard; no RC cancel, no deleteOne", async () => {
    const pd = makePendingDomain({ isArchived: false });
    getPendingDomainById.mockResolvedValueOnce(pd);
    const res = await DELETE(
      makeReq("DELETE", { query: "permanent=true" }),
      paramsOf("PD1")
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/archive/i);
    expect(deleteDomainOrder).not.toHaveBeenCalled();
    expect(pendingDomainDeleteOne).not.toHaveBeenCalled();
  });

  it("RC orderId present → deleteDomainOrder called; success → registrarStatus:'cancelled'", async () => {
    setupPendingWithOrderId("RC-99");
    deleteDomainOrder.mockResolvedValueOnce({ status: "success" });

    const res = await DELETE(
      makeReq("DELETE", { query: "permanent=true" }),
      paramsOf("PD1")
    );

    expect(deleteDomainOrder).toHaveBeenCalledWith("RC-99");
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.registrarStatus).toBe("cancelled");
  });

  it("RC orderId missing → rcGetDomainOrderId fallback search by domainName", async () => {
    setupPendingWithOrderId(undefined);
    rcGetDomainOrderId.mockResolvedValueOnce({
      kind: "found",
      orderId: "RC-RECOVERED",
    });
    deleteDomainOrder.mockResolvedValueOnce({ status: "success" });

    await DELETE(
      makeReq("DELETE", { query: "permanent=true" }),
      paramsOf("PD1")
    );

    expect(rcGetDomainOrderId).toHaveBeenCalledWith({
      domainName: "ex.com",
    });
    expect(deleteDomainOrder).toHaveBeenCalledWith("RC-RECOVERED");
  });

  it("RC search returns 'not_found' → deletion proceeds without registrar cancellation", async () => {
    setupPendingWithOrderId(undefined);
    rcGetDomainOrderId.mockResolvedValueOnce({ kind: "not_found" });

    const res = await DELETE(
      makeReq("DELETE", { query: "permanent=true" }),
      paramsOf("PD1")
    );

    expect(deleteDomainOrder).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registrarStatus).toBe("skipped_or_failed");
  });

  it("RC cancel error captured but deletion proceeds", async () => {
    setupPendingWithOrderId("RC-99");
    deleteDomainOrder.mockResolvedValueOnce({
      status: "error",
      message: "Registrar offline",
    });

    const res = await DELETE(
      makeReq("DELETE", { query: "permanent=true" }),
      paramsOf("PD1")
    );

    expect(pendingDomainDeleteOne).toHaveBeenCalled();
    const body = await res.json();
    expect(body.message).toContain("Registrar: Registrar offline");
  });

  it("RC cancel throw → message captured, deletion still proceeds", async () => {
    setupPendingWithOrderId("RC-99");
    deleteDomainOrder.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await DELETE(
      makeReq("DELETE", { query: "permanent=true" }),
      paramsOf("PD1")
    );

    expect(pendingDomainDeleteOne).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("Order sync: domain status → 'cancelled' + bookingStatus appended", async () => {
    setupPendingWithOrderId("RC-99");
    deleteDomainOrder.mockResolvedValueOnce({ status: "success" });
    const order = makeOrder();
    getOrderByOrderId.mockResolvedValueOnce(order);

    await DELETE(
      makeReq("DELETE", { query: "permanent=true" }),
      paramsOf("PD1")
    );

    expect(order.domains[0].status).toBe("cancelled");
    const lastBs =
      order.domains[0].bookingStatus[order.domains[0].bookingStatus.length - 1];
    expect(lastBs.step).toBe("domain_failed");
    expect(lastBs.message).toMatch(/cancelled by admin.*Confirmed with registrar/);
    expect(order.save).toHaveBeenCalled();
  });

  it("Domain.deleteMany cleanup: {domainName, orderId} filter", async () => {
    setupPendingWithOrderId("RC-99");
    deleteDomainOrder.mockResolvedValueOnce({ status: "success" });

    await DELETE(
      makeReq("DELETE", { query: "permanent=true" }),
      paramsOf("PD1")
    );

    expect(domainDeleteMany).toHaveBeenCalledWith({
      domainName: "ex.com",
      orderId: "ORD-1",
    });
  });

  it("Domain.deleteMany throw SWALLOWED (response still 200)", async () => {
    setupPendingWithOrderId("RC-99");
    deleteDomainOrder.mockResolvedValueOnce({ status: "success" });
    domainDeleteMany.mockRejectedValueOnce(new Error("DB down"));

    const res = await DELETE(
      makeReq("DELETE", { query: "permanent=true" }),
      paramsOf("PD1")
    );
    expect(res.status).toBe(200);
  });
});

// ─── DELETE — soft-archive branch ──────────────────────────────────
describe("DELETE — soft-archive branch (default, no ?permanent)", () => {
  function setupPending() {
    const pd = makePendingDomain();
    getPendingDomainById.mockResolvedValueOnce(pd);
    return pd;
  }

  it("archive sets isArchived/archivedAt/archivedBy/status:'failed'", async () => {
    setupPending();
    await DELETE(makeReq("DELETE"), paramsOf("PD1"));
    const [, update] = pendingDomainFindOneAndUpdate.mock.calls[0];
    expect(update.isArchived).toBe(true);
    expect(update.archivedAt).toBeInstanceOf(Date);
    expect(update.archivedBy).toBe("admin@x.com");
    expect(update.status).toBe("failed");
  });

  it("does NOT call ResellerClub.deleteDomainOrder (archive ≠ permanent)", async () => {
    setupPending();
    await DELETE(makeReq("DELETE"), paramsOf("PD1"));
    expect(deleteDomainOrder).not.toHaveBeenCalled();
  });

  it("order sync: domain status='failed', error stamped with reason, bookingStatus appended", async () => {
    setupPending();
    const order = makeOrder();
    getOrderByOrderId.mockResolvedValueOnce(order);

    await DELETE(makeReq("DELETE"), paramsOf("PD1"));

    expect(order.domains[0].status).toBe("failed");
    expect(order.save).toHaveBeenCalled();
  });

  it("failure email sent via sendPurchaseOrderEmail when customer.email present", async () => {
    setupPending();
    const order = makeOrder();
    getOrderByOrderId.mockResolvedValueOnce(order);

    await DELETE(makeReq("DELETE"), paramsOf("PD1"));

    expect(sendPurchaseOrderEmail).toHaveBeenCalled();
    const [email, name, payload] = sendPurchaseOrderEmail.mock.calls[0];
    expect(email).toBe("u@x.com");
    expect(name).toBe("First Last");
    expect(payload.registrationFailed).toBe(true);
    expect(payload.paymentStatus).toBe("success"); // order.status='completed'
  });

  it("email failure SWALLOWED — response still 200", async () => {
    setupPending();
    const order = makeOrder();
    getOrderByOrderId.mockResolvedValueOnce(order);
    sendPurchaseOrderEmail.mockRejectedValueOnce(new Error("SMTP down"));

    const res = await DELETE(makeReq("DELETE"), paramsOf("PD1"));
    expect(res.status).toBe(200);
  });

  it("no customer email → skips sendPurchaseOrderEmail (no crash on missing populated user)", async () => {
    const pd = makePendingDomain({ userId: "RAW_UNPOPULATED_OID" });
    getPendingDomainById.mockResolvedValueOnce(pd);
    const order = makeOrder();
    getOrderByOrderId.mockResolvedValueOnce(order);

    await DELETE(makeReq("DELETE"), paramsOf("PD1"));

    expect(sendPurchaseOrderEmail).not.toHaveBeenCalled();
  });

  it("no orderId → skips order-sync entirely", async () => {
    const pd = makePendingDomain({ orderId: undefined });
    getPendingDomainById.mockResolvedValueOnce(pd);

    await DELETE(makeReq("DELETE"), paramsOf("PD1"));

    expect(getOrderByOrderId).not.toHaveBeenCalled();
    expect(sendPurchaseOrderEmail).not.toHaveBeenCalled();
  });

  it("order sync throw SWALLOWED (response still 200)", async () => {
    setupPending();
    getOrderByOrderId.mockRejectedValueOnce(new Error("DB down"));

    const res = await DELETE(makeReq("DELETE"), paramsOf("PD1"));
    expect(res.status).toBe(200);
  });

  it("happy path response: 'Pending domain archived successfully'", async () => {
    setupPending();
    const res = await DELETE(makeReq("DELETE"), paramsOf("PD1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Pending domain archived successfully");
  });
});

// ─── DELETE — outer catch ──────────────────────────────────────────
describe("DELETE — outer catch", () => {
  it("getPendingDomainById throw → 500 'Failed to process pending domain: <msg>' (exposes detail)", async () => {
    getPendingDomainById.mockRejectedValueOnce(new Error("DB outage"));
    const res = await DELETE(makeReq("DELETE"), paramsOf("PD1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Failed to process pending domain: DB outage/);
  });
});
