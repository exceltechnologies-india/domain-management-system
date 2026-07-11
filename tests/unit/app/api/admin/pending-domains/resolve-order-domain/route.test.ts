/**
 * Tests for `app/api/admin/pending-domains/resolve-order-domain/route.ts`.
 *
 * Admin closes out an ORDER-SOURCED stuck in-flight domain (a row with a
 * synthetic _id and no PendingDomain doc). Flips the Order's domain status
 * to failed (or cancelled when also cancelled at ResellerClub) so it drops
 * off the in-flight projection.
 *
 * Pins:
 *  - Admin auth gate → 401
 *  - Order not found → 404; domain not on order → 404
 *  - Domain not in-flight (already settled) → 400 (no clobber)
 *  - Happy path (no registrar) → domain.status='failed', save + markModified
 *  - cancelAtRegistrar success → status='cancelled', deleteDomainOrder called
 *  - cancelAtRegistrar failure → still resolves as 'failed' (best-effort)
 *  - RC order-id absent → fallback search; if not found → failed + note
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getAdminFromRequest } }));

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const getOrderByOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ getOrderByOrderId }));

const deleteDomainOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { deleteDomainOrder },
}));

const rcGetDomainOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/resellerclub", () => ({
  getDomainOrderId: rcGetDomainOrderId,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/pending-domains/resolve-order-domain/route";

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/admin/pending-domains/resolve-order-domain",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function makeOrder(overrides: Partial<any> = {}): any {
  return {
    orderId: "ORD-1",
    domains: [{ domainName: "ex.com", status: "pending", bookingStatus: [] }],
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const admin = { _id: "A1", email: "admin@x.com", role: "admin" };
const validBody = { orderId: "ORD-1", domainName: "ex.com" };

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  connectDB.mockReset().mockResolvedValue(undefined);
  getOrderByOrderId.mockReset();
  deleteDomainOrder.mockReset();
  rcGetDomainOrderId.mockReset();
});

describe("auth gate", () => {
  it("no admin → 401; order never fetched", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(401);
    expect(getOrderByOrderId).not.toHaveBeenCalled();
  });
});

describe("not found", () => {
  it("order missing → 404", async () => {
    getOrderByOrderId.mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
  });

  it("domain not on order → 404", async () => {
    getOrderByOrderId.mockResolvedValueOnce(makeOrder({ domains: [{ domainName: "other.com", status: "pending", bookingStatus: [] }] }));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
  });
});

describe("in-flight guard", () => {
  it("domain already settled (completed) → 400; not clobbered", async () => {
    const order = makeOrder({ domains: [{ domainName: "ex.com", status: "completed", bookingStatus: [] }] });
    getOrderByOrderId.mockResolvedValueOnce(order);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    expect(order.save).not.toHaveBeenCalled();
    expect(order.domains[0].status).toBe("completed");
  });
});

describe("happy path — no registrar cancel", () => {
  it("marks domain 'failed', appends bookingStatus, saves", async () => {
    const order = makeOrder();
    getOrderByOrderId.mockResolvedValueOnce(order);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe("failed");
    expect(order.domains[0].status).toBe("failed");
    expect(order.domains[0].bookingStatus.at(-1).step).toBe("domain_failed");
    expect(order.markModified).toHaveBeenCalledWith("domains");
    expect(order.save).toHaveBeenCalled();
    expect(deleteDomainOrder).not.toHaveBeenCalled();
  });
});

describe("cancelAtRegistrar", () => {
  it("registrar success → status 'cancelled'; deleteDomainOrder called with row's rc order id", async () => {
    const order = makeOrder({ domains: [{ domainName: "ex.com", status: "pending", bookingStatus: [], resellerClubOrderId: "RC-77" }] });
    getOrderByOrderId.mockResolvedValueOnce(order);
    deleteDomainOrder.mockResolvedValueOnce({ status: "success" });
    const res = await POST(makeReq({ ...validBody, cancelAtRegistrar: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("cancelled");
    expect(body.registrarCancelled).toBe(true);
    expect(deleteDomainOrder).toHaveBeenCalledWith("RC-77");
    expect(order.domains[0].status).toBe("cancelled");
  });

  it("registrar failure → still resolves as 'failed' (best-effort)", async () => {
    const order = makeOrder({ domains: [{ domainName: "ex.com", status: "pending", bookingStatus: [], resellerClubOrderId: "RC-77" }] });
    getOrderByOrderId.mockResolvedValueOnce(order);
    deleteDomainOrder.mockResolvedValueOnce({ status: "error", message: "RC offline" });
    const res = await POST(makeReq({ ...validBody, cancelAtRegistrar: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.registrarCancelled).toBe(false);
    expect(order.save).toHaveBeenCalled();
  });

  it("no rc order id on domain → fallback search; not found → failed, no deleteDomainOrder", async () => {
    const order = makeOrder(); // domain has no resellerClubOrderId
    getOrderByOrderId.mockResolvedValueOnce(order);
    rcGetDomainOrderId.mockResolvedValueOnce({ kind: "not_found" });
    const res = await POST(makeReq({ ...validBody, cancelAtRegistrar: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(rcGetDomainOrderId).toHaveBeenCalledWith({ domainName: "ex.com" });
    expect(deleteDomainOrder).not.toHaveBeenCalled();
  });
});
