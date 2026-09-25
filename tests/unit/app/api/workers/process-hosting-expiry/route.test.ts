/**
 * Tests for `app/api/workers/process-hosting-expiry/route.ts` (slice 7i4, part 2).
 *
 * Daily worker: suspends an expired hosting account (a paid one, or a free
 * trial at its end) and tells the customer. Since 25 Sep 2026 it raises NO
 * DMS renewal order and sends no DMS renewal amount: renewals are
 * ResellerOS's (owner decisions, 24-25 Sep 2026). No invoice is issued.
 *
 * Threat model:
 *  - **Mass-suspension on a flaky probe**: a refactor that suspends
 *    based on stale data would lock customers out incorrectly.
 *    Pinned: status='active' AND expiryDate < now BOTH required.
 *  - **Phantom invoice for unpaid renewals**: a refactor that called
 *    the invoicing engine (createPrimaryInvoice) here would issue a tax
 *    invoice — consuming a number from the gapless GST series — for an
 *    account the customer hasn't paid yet. Pinned via a comment-stripped
 *    source scan (no invoicing import) + email payload without
 *    invoiceNumber.
 *  - **Permanent-vs-transient response**: 200 (no retry) for
 *    permanent skips; 500 (Cloud Tasks retries) for transient errors.
 *
 * Other pins:
 *  - cron-secret → 401
 *  - zod hostingId required
 *  - hosting not found → 200 success:false (no retry)
 *  - status !== 'active' → 200 "Skipped (not active)" (idempotent)
 *  - expiryDate missing OR > now → 200 "Skipped (not expired)"
 *  - DA suspendUser called with the directAdminUsername + reason
 *  - missing directAdminUsername → skipped DA call
 *  - NO createOrder and NO renewal-invoice email, for any plan and for a
 *    trial; the suspension email is sent instead; status = 'suspended'; save
 *  - Inner catch (DA suspend throw, etc.) → 500 PROCESSING_FAILED
 *  - Outer catch → 500 INTERNAL_ERROR
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const getHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ getHostingById }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const createOrder = vi.hoisted(() => vi.fn());
const getOrderByOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  createOrder,
  getOrderByOrderId,
}));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const suspendUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { suspendUser },
}));

// No @/config/hosting-plans mock: the renewal price is the REAL ResellerOS
// figure (lib/pricing/hosting-price.ts). Mocking it with invented prices is
// how the old per-month-as-yearly bug stayed invisible.

const sendRenewalInvoiceEmail = vi.hoisted(() => vi.fn());
const sendServiceSuspensionEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendRenewalInvoiceEmail, sendServiceSuspensionEmail },
}));
const sendServiceSuspended = vi.hoisted(() => vi.fn());
vi.mock("@/lib/whatsapp", () => ({ WhatsAppService: { sendServiceSuspended } }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/workers/process-hosting-expiry/route";

function makeReq(body: unknown = { hostingId: "H1" }) {
  return new NextRequest(
    "https://example.com/api/workers/process-hosting-expiry",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function makeHosting(overrides: Record<string, unknown> = {}) {
  return {
    _id: "H1",
    domainName: "example.com",
    directAdminUsername: "alice_da",
    status: "active",
    expiryDate: new Date(Date.now() - 86_400_000), // 1 day expired
    planId: "starter",
    name: "Starter",
    serverPackage: "Starter",
    orderId: "ORD-1",
    userId: "U1",
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const user = {
  _id: "U1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Smith",
};

beforeEach(() => {
  authorizeCronRequest.mockReset().mockReturnValue(true);
  getHostingById.mockReset();
  getUserById.mockReset().mockResolvedValue(user);
  createOrder.mockReset().mockImplementation(async (data) => data);
  getOrderByOrderId.mockReset();
  getPlanByPlanId.mockReset();
  suspendUser.mockReset().mockResolvedValue(undefined);
  sendRenewalInvoiceEmail.mockReset().mockResolvedValue(undefined);
  sendServiceSuspensionEmail.mockReset().mockResolvedValue(true);
  sendServiceSuspended.mockReset().mockResolvedValue(undefined);
});

describe("Auth gate", () => {
  it("no cron-secret → 401; no DB work", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(getHostingById).not.toHaveBeenCalled();
  });
});

describe("Zod schema", () => {
  it("missing hostingId → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });
});

describe("Idempotency skips (200, no retry)", () => {
  it("hosting not found → 200 success:false 'Hosting not found'", async () => {
    getHostingById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(suspendUser).not.toHaveBeenCalled();
  });

  it("status !== 'active' (e.g. 'suspended') → 200 'Skipped (not active)'", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ status: "suspended" })
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("not active");
    expect(suspendUser).not.toHaveBeenCalled();
  });

  it("expiryDate in future → 200 'Skipped (not expired)'", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ expiryDate: new Date(Date.now() + 86_400_000) })
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("not expired");
  });

  it("expiryDate missing → 200 'Skipped (not expired)'", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ expiryDate: undefined })
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
  });
});

describe("DA suspension", () => {
  it("directAdminUsername present → suspendUser called with username + reason", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    await POST(makeReq());
    expect(suspendUser).toHaveBeenCalledWith(
      "alice_da",
      expect.stringContaining("Expired")
    );
  });

  it("directAdminUsername absent → suspendUser NOT called (still marks suspended and tells the customer)", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ directAdminUsername: undefined })
    );
    const res = await POST(makeReq());
    expect(suspendUser).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(sendServiceSuspensionEmail).toHaveBeenCalledTimes(1);
  });
});

// Renewals are ResellerOS's (owner decisions, 24-25 Sep 2026). This worker
// used to raise a pending DMS renewal Order at a DMS-computed price and email
// it as a "renewal invoice" — at the end of a free trial too. It raises none.
describe("No DMS renewal order — renewals are ResellerOS's", () => {
  it.each([["starter"], ["Plus"], ["25GB-wp"], [undefined]])(
    "plan %s: suspended, NO renewal order, NO renewal-invoice email",
    async (planId) => {
      const hosting = makeHosting({ planId });
      getHostingById.mockResolvedValueOnce(hosting);
      const res = await POST(makeReq());
      expect(res.status).toBe(200);
      expect(createOrder).not.toHaveBeenCalled();
      expect(sendRenewalInvoiceEmail).not.toHaveBeenCalled();
      expect(hosting.status).toBe("suspended");
      expect(hosting.save).toHaveBeenCalledTimes(1);
    }
  );

  it("a free trial at its end raises no order either", async () => {
    const hosting = makeHosting({ isTrial: true });
    getHostingById.mockResolvedValueOnce(hosting);
    await POST(makeReq());
    expect(createOrder).not.toHaveBeenCalled();
    expect(sendRenewalInvoiceEmail).not.toHaveBeenCalled();
    expect(hosting.status).toBe("suspended");
  });

  it("the route no longer imports the order service or a price (source scan, comments stripped)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(process.cwd(), "app/api/workers/process-hosting-expiry/route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/createOrder|hostingCharge|sendRenewalInvoiceEmail/);
  });
});

describe("No invoicing on an unpaid renewal (source scan, comments stripped)", () => {
  it("the route imports neither the invoicing engine nor a Zoho client", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "app/api/workers/process-hosting-expiry/route.ts"),
      "utf8"
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/createPrimaryInvoice|billing\/createPrimaryInvoice|zohobooks|ZohoBooksService/);
  });
});

describe("Telling the customer", () => {
  it("the suspension email is sent (no amount, no invoice number), plus WhatsApp when on file", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    getUserById.mockResolvedValueOnce({ ...user, whatsappNumber: "9876543210" });
    await POST(makeReq());
    expect(sendServiceSuspensionEmail).toHaveBeenCalledWith("alice@example.com", {
      serviceName: "example.com",
      serviceType: "hosting",
    });
    expect(sendServiceSuspended).toHaveBeenCalledWith("9876543210", { serviceName: "example.com", serviceType: "hosting" });
  });

  it("a failing email does not stop the suspension", async () => {
    const h = makeHosting();
    getHostingById.mockResolvedValueOnce(h);
    sendServiceSuspensionEmail.mockRejectedValueOnce(new Error("smtp down"));
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(h.status).toBe("suspended");
  });

  it("user not found → email NOT sent; hosting still suspended", async () => {
    const h = makeHosting();
    getHostingById.mockResolvedValueOnce(h);
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(sendServiceSuspensionEmail).not.toHaveBeenCalled();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.status).toBe("suspended");
  });
});

describe("Status flip + persistence", () => {
  it("hosting.status = 'suspended' + save called once on happy path", async () => {
    const h = makeHosting();
    getHostingById.mockResolvedValueOnce(h);
    await POST(makeReq());
    expect(h.status).toBe("suspended");
    expect(h.save).toHaveBeenCalledTimes(1);
  });
});

describe("Inner-catch (transient retry)", () => {
  it("**suspendUser throw → 500 PROCESSING_FAILED (Cloud Tasks retries)**", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    suspendUser.mockRejectedValueOnce(new Error("DA unreachable"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("PROCESSING_FAILED");
  });

  it("hosting.save throw → 500 PROCESSING_FAILED", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting({ save: vi.fn().mockRejectedValue(new Error("Mongo blip")) }));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
  });
});

describe("Outer-catch", () => {
  it("getHostingById throw → 500 INTERNAL_ERROR", async () => {
    getHostingById.mockRejectedValueOnce(new Error("Mongo cluster down"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});
