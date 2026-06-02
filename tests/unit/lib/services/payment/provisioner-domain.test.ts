/**
 * Tests for `@/lib/services/payment/provisioner-domain` (rescan-4
 * slice 7fb). Per-item domain provisioner — switches on the typed
 * `RegisterDomainOutcome` returned by the M1 integration layer. Pins:
 *  - **EXISTING ACTIVE DOMAIN SHORT-CIRCUIT**: when a non-deleted
 *    Domain row already exists for the name → SKIPS RC call entirely,
 *    returns 'already_registered' + status:'registered' (defence
 *    against re-registering a soft-deleted-then-repurchased domain)
 *  - rcRegisterDomain called with the right shape (domainName, years,
 *    customerId, contacts mirroring single contactId across admin/
 *    tech/billing, tldAttributes, no nameServers — RC defaults)
 *  - 'registered' outcome → status:'pending' (locally) + writes Domain
 *    record + calls calculateItemExpiration; **next_action_at =
 *    expiresAt - FIRST_REMINDER_DAYS** (renewal-reminder cron pre-stamp)
 *  - 'registered' with NO orderId in response → calls
 *    `fetchOrderIdFallback` (best-effort RC lookup)
 *  - 'registered_no_order_id' branch ALWAYS calls fetchOrderIdFallback
 *  - **Domain.create failure SWALLOWED** (logged + still returns
 *    success — don't fail the payment over a local-DB blip)
 *  - 'balance_pending' / 'already_in_progress' → status:'pending' +
 *    distinct user-facing error message; both call fetchOrderIdFallback
 *  - **'hard_failure' → status:'failed'** with the generic user-facing
 *    error 'Domain registration failed. Our team has been notified —
 *    please contact support if this persists.' (internal reason
 *    discarded — already logged in integration layer)
 *  - Catch-block: a throw inside dispatchOutcome maps to a synthetic
 *    'hard_failure' outcome (error.message passed as reason)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const domainFindOne = vi.hoisted(() => vi.fn());
const domainCreate = vi.hoisted(() => vi.fn());
vi.mock("@/models/Domain", () => ({
  default: { findOne: domainFindOne, create: domainCreate },
}));

const calculateItemExpiration = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing", () => ({ calculateItemExpiration }));

vi.mock("@/config/automation", () => ({
  AUTOMATION_CONFIG: { REMINDER_DAYS: [30, 14, 7, 1] },
}));

const rcRegisterDomain = vi.hoisted(() => vi.fn());
const rcGetDomainOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/resellerclub", () => ({
  registerDomain: rcRegisterDomain,
  getDomainOrderId: rcGetDomainOrderId,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { provisionDomainItem } from "@/lib/services/payment/provisioner-domain";

const CTX = {
  user: { _id: "USER_ID" },
  orderId: "ord_42",
  cartItems: [],
  customerResult: { customerId: 7, contactId: 100 },
} as never;

const ITEM: Record<string, unknown> = {
  domainName: "x.com",
  itemType: "domain",
  price: 999,
  currency: "INR",
  registrationPeriod: 1,
  periodUnit: "years",
};

beforeEach(() => {
  domainFindOne.mockReset();
  domainCreate.mockReset();
  calculateItemExpiration.mockReset();
  calculateItemExpiration.mockReturnValue({
    expiresAt: new Date("2027-01-01"),
  });
  rcRegisterDomain.mockReset();
  rcGetDomainOrderId.mockReset();
  // Default: findOne chain with .lean() returning null (no existing row).
  domainFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
});

describe("provisionDomainItem — existing-domain short-circuit", () => {
  it("active Domain row exists → SKIPS RC call + returns 'already_registered'", async () => {
    domainFindOne.mockReturnValueOnce({
      lean: () =>
        Promise.resolve({ _id: "D1", domainName: "x.com", deletedAt: null }),
    });
    const result = await provisionDomainItem(ITEM as never, CTX);
    expect(rcRegisterDomain).not.toHaveBeenCalled();
    expect(result.registrationResult.status).toBe("already_registered");
    expect(result.successfulDomain).toBe("x.com");
    expect(result.orderDomain.status).toBe("registered");
  });

  it("findOne filter: deletedAt: null (soft-deleted rows DON'T count as active)", async () => {
    domainFindOne.mockReturnValueOnce({
      lean: () => Promise.resolve(null),
    });
    rcRegisterDomain.mockResolvedValueOnce({
      kind: "registered",
      orderId: "RC_ORDER_99",
    });
    await provisionDomainItem(ITEM as never, CTX);
    const [filter] = domainFindOne.mock.calls[0];
    expect(filter).toEqual({ domainName: "x.com", deletedAt: null });
  });
});

describe("provisionDomainItem — RC call shape", () => {
  it("contacts: admin/tech/billing all set to customerResult.contactId (single-contact convention)", async () => {
    rcRegisterDomain.mockResolvedValueOnce({
      kind: "registered",
      orderId: "RC_ORDER_99",
    });
    await provisionDomainItem(ITEM as never, CTX);
    expect(rcRegisterDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        contacts: { admin: 100, tech: 100, billing: 100 },
        customerId: 7,
        years: 1,
        domainName: "x.com",
      })
    );
  });

  it("nameservers: NOT supplied (RC's defaults are used per current policy)", async () => {
    rcRegisterDomain.mockResolvedValueOnce({
      kind: "registered",
      orderId: "RC_ORDER_99",
    });
    await provisionDomainItem(ITEM as never, CTX);
    const [args] = rcRegisterDomain.mock.calls[0];
    expect(args.nameServers).toBeUndefined();
  });

  it("tldAttributes pass through (per-TLD attributes collected at checkout)", async () => {
    rcRegisterDomain.mockResolvedValueOnce({
      kind: "registered",
      orderId: "RC_ORDER_99",
    });
    await provisionDomainItem(
      { ...ITEM, tldAttributes: { "us-nexus": "C11" } } as never,
      CTX
    );
    expect(rcRegisterDomain.mock.calls[0][0].tldAttributes).toEqual({
      "us-nexus": "C11",
    });
  });
});

describe("provisionDomainItem — 'registered' outcome", () => {
  it("happy path: status:'pending' locally + Domain row created + next_action_at = expiresAt - 30 days", async () => {
    const expiresAt = new Date("2027-01-01");
    calculateItemExpiration.mockReturnValueOnce({ expiresAt });
    rcRegisterDomain.mockResolvedValueOnce({
      kind: "registered",
      orderId: "RC_ORDER_99",
    });
    domainCreate.mockResolvedValueOnce({});
    const result = await provisionDomainItem(ITEM as never, CTX);
    expect(result.registrationResult.status).toBe("success");
    expect(result.registrationResult.orderId).toBe("RC_ORDER_99");
    expect(result.orderDomain.status).toBe("pending"); // locally pending — verify-phase confirms
    expect(domainCreate).toHaveBeenCalled();
    const [createPayload] = domainCreate.mock.calls[0];
    expect(createPayload.domainName).toBe("x.com");
    expect(createPayload.resellerClubOrderId).toBe("RC_ORDER_99");
    expect(createPayload.expiresAt).toBe(expiresAt);
    // FIRST_REMINDER_DAYS = max(30, 14, 7, 1) = 30
    expect(createPayload.next_action_at.getTime()).toBe(
      expiresAt.getTime() - 30 * 24 * 60 * 60 * 1000
    );
  });

  it("'registered' WITHOUT orderId → calls fetchOrderIdFallback (best-effort lookup)", async () => {
    rcRegisterDomain.mockResolvedValueOnce({
      kind: "registered",
      orderId: undefined,
    });
    rcGetDomainOrderId.mockResolvedValueOnce({
      kind: "found",
      orderId: "FALLBACK_ORDER",
    });
    const result = await provisionDomainItem(ITEM as never, CTX);
    expect(rcGetDomainOrderId).toHaveBeenCalledWith({ domainName: "x.com" });
    expect(result.registrationResult.orderId).toBe("FALLBACK_ORDER");
  });

  it("'registered_no_order_id' branch ALWAYS calls fetchOrderIdFallback", async () => {
    rcRegisterDomain.mockResolvedValueOnce({ kind: "registered_no_order_id" });
    rcGetDomainOrderId.mockResolvedValueOnce({
      kind: "found",
      orderId: "FALLBACK_NOI",
    });
    const result = await provisionDomainItem(ITEM as never, CTX);
    expect(rcGetDomainOrderId).toHaveBeenCalled();
    expect(result.registrationResult.orderId).toBe("FALLBACK_NOI");
  });

  it("fetchOrderIdFallback throw is SWALLOWED (best-effort)", async () => {
    rcRegisterDomain.mockResolvedValueOnce({
      kind: "registered",
      orderId: undefined,
    });
    rcGetDomainOrderId.mockRejectedValueOnce(new Error("fallback failed"));
    const result = await provisionDomainItem(ITEM as never, CTX);
    expect(result.registrationResult.status).toBe("success");
    expect(result.registrationResult.orderId).toBeUndefined();
  });

  it("Domain.create failure SWALLOWED (logged + still returns success — local-DB blip)", async () => {
    rcRegisterDomain.mockResolvedValueOnce({
      kind: "registered",
      orderId: "RC_ORDER_99",
    });
    domainCreate.mockRejectedValueOnce(new Error("duplicate key"));
    const result = await provisionDomainItem(ITEM as never, CTX);
    expect(result.registrationResult.status).toBe("success");
    expect(result.orderDomain.status).toBe("pending");
  });
});

describe("provisionDomainItem — pending branches", () => {
  it("'balance_pending' → status:'pending' with insufficient-balance message + RC orderId fallback", async () => {
    rcRegisterDomain.mockResolvedValueOnce({ kind: "balance_pending" });
    rcGetDomainOrderId.mockResolvedValueOnce({
      kind: "found",
      orderId: "PENDING_RC_ORDER",
    });
    const result = await provisionDomainItem(ITEM as never, CTX);
    expect(result.registrationResult.status).toBe("pending");
    expect(result.registrationResult.error).toMatch(/insufficient balance/i);
    expect(result.orderDomain.status).toBe("pending");
    expect(result.orderDomain.resellerClubOrderId).toBe("PENDING_RC_ORDER");
    // Domain row NOT created on pending paths.
    expect(domainCreate).not.toHaveBeenCalled();
  });

  it("'already_in_progress' → status:'pending' with distinct 'being processed' message", async () => {
    rcRegisterDomain.mockResolvedValueOnce({ kind: "already_in_progress" });
    rcGetDomainOrderId.mockResolvedValueOnce({ kind: "not_found", reason: "" });
    const result = await provisionDomainItem(ITEM as never, CTX);
    expect(result.registrationResult.status).toBe("pending");
    expect(result.registrationResult.error).toMatch(/being processed/i);
  });
});

describe("provisionDomainItem — failure branches", () => {
  it("'hard_failure' → status:'failed' with GENERIC user message (internal reason discarded)", async () => {
    rcRegisterDomain.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "TLD-PolicyError: Internal-detail-leaks-through",
    });
    const result = await provisionDomainItem(ITEM as never, CTX);
    expect(result.registrationResult.status).toBe("failed");
    expect(result.orderDomain.status).toBe("failed");
    // Generic message — internal reason MUST NOT leak.
    expect(result.registrationResult.error).toMatch(
      /Our team has been notified/
    );
    expect(result.registrationResult.error).not.toMatch(
      /Internal-detail-leaks-through/
    );
  });

  it("hard-failure attaches a 'domain_failed' bookingStatus step at progress:100", async () => {
    rcRegisterDomain.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "x",
    });
    const result = await provisionDomainItem(ITEM as never, CTX);
    const lastStep = (
      result.orderDomain.bookingStatus as Array<{ step: string; progress: number }>
    ).at(-1);
    expect(lastStep?.step).toBe("domain_failed");
    expect(lastStep?.progress).toBe(100);
  });

  it("rcRegisterDomain throw → caught + dispatched as synthetic 'hard_failure'", async () => {
    // rcRegisterDomain normally catches its own exceptions, but a bug
    // / future regression could let one bubble. The outer try/catch is
    // the last-line defence: synthesise a hard_failure outcome and
    // return a failed result rather than letting the throw bubble up
    // into the payment-verify response.
    rcRegisterDomain.mockRejectedValueOnce(new Error("unmapped RC throw"));
    const result = await provisionDomainItem(ITEM as never, CTX);
    expect(result.registrationResult.status).toBe("failed");
    expect(result.orderDomain.status).toBe("failed");
  });
});
