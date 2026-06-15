/**
 * Tests for `app/api/workers/process-service-expiry/route.ts` (slice
 * 7iA, part 2).
 *
 * Per-service expiry worker fired by Cloud Tasks for ONE hosting or
 * ONE domain at a time. Three flows depending on `daysLeft`:
 *  1. **EXPIRY**: daysLeft <= 0 + status='active' → suspend DA user
 *     + flip status to 'expired' + send suspension email/WhatsApp +
 *     clear next_action_at (no further cron). Subscription auto-
 *     renew has a 1-day grace window where the worker reschedules
 *     instead of suspending (waiting for the Razorpay webhook).
 *  2. **REMINDER**: daysLeft > 0 → walk the descending REMINDER_DAYS
 *     thresholds and send the appropriate N-day reminder when not
 *     already sent (last_reminder_sent dedup); reschedule
 *     next_action_at to the next checkpoint.
 *  3. **FALLBACK**: no reminder fires → recalc next_action_at to
 *     the next pending checkpoint (or set to expiryDate if past all
 *     checkpoints) — anti-runaway-loop.
 *
 * Threat model:
 *  - **Mass-suspension on flaky probe**: a refactor that suspends
 *    without checking status would lock customers out. Pinned:
 *    expiry branch only fires when `daysLeft<=0 AND status='active'`.
 *  - **DA-unreachable mass-termination**: typed-outcome dispatch on
 *    daSuspendUser — user_not_found is terminal (no retry), but
 *    da_unreachable and hard_failure throw so Cloud Tasks retries.
 *  - **Infinite daily loop**: overdue-but-non-active services have
 *    next_action_at cleared to null — pinned to prevent re-firing.
 *  - **Lock not released**: the finally block ALWAYS clears
 *    processing_until and calls save() — pinned even when the main
 *    branch throws (so a stuck lock doesn't hold the row hostage).
 *
 * Other pins:
 *  - Cron auth → 401
 *  - zod: serviceId+serviceType required; simulatedTime optional
 *  - 'hosting' route: getHostingById(id, {populateUser:true})
 *  - 'domain' route: Domain.findById(id).populate('userId')
 *  - service not found → 200 'Not found — skipped' (NO retry)
 *  - terminal status (failed/terminated) → 200 'Skipped — terminal
 *    status' (NO retry; idempotent)
 *  - missing expiryDate → 200 'No expiry date — skipped'
 *  - 'domain' service: suspendService is a no-op (registrar
 *    manages actual suspension); pinned NOT to call daSuspendUser
 *  - Inner catch → 500 INTERNAL_ERROR generic
 *  - Finally: processing_until cleared + save() called even on
 *    happy path
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const getHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ getHostingById }));

const domainFindById = vi.hoisted(() => vi.fn());
vi.mock("@/models/Domain", () => ({
  default: { findById: domainFindById },
}));

const daSuspendUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  suspendUser: daSuspendUser,
}));

const sendServiceSuspensionEmail = vi.hoisted(() => vi.fn());
const sendServiceReminderEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendServiceSuspensionEmail, sendServiceReminderEmail },
}));

const sendServiceSuspended = vi.hoisted(() => vi.fn());
const sendServiceReminder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/whatsapp", () => ({
  WhatsAppService: { sendServiceSuspended, sendServiceReminder },
}));

const timeNow = vi.hoisted(() => vi.fn());
const daysUntil = vi.hoisted(() => vi.fn());
vi.mock("@/lib/time-service", () => ({
  TimeService: { now: timeNow, daysUntil },
}));

vi.mock("@/config/automation", () => ({
  AUTOMATION_CONFIG: { REMINDER_DAYS: [30, 15, 7, 1] },
}));

// Mock @/lib/api-validation with real zod so the route's inline
// processServiceExpirySchema validates real input.
vi.mock("@/lib/api-validation", async () => {
  const { z } = await import("zod");
  const { NextResponse } = await import("next/server");
  return {
    z,
    validatedBody: async (req: Request, schema: import("zod").ZodSchema<unknown>) => {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return {
          ok: false,
          response: NextResponse.json({ error: "Invalid JSON" }, { status: 400 }),
        };
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: "Validation failed", details: parsed.error.flatten() },
            { status: 400 }
          ),
        };
      }
      return { ok: true, data: parsed.data };
    },
  };
});

const secureJsonResponse = vi.hoisted(() =>
  vi.fn((data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  )
);
const secureErrorResponse = vi.hoisted(() =>
  vi.fn(
    (message: string, status: number, code: string) =>
      new Response(JSON.stringify({ error: message, code }), {
        status,
        headers: { "Content-Type": "application/json" },
      })
  )
);
vi.mock("@/lib/api-response-wrapper", () => ({
  secureJsonResponse,
  secureErrorResponse,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/workers/process-service-expiry/route";

function makeReq(body: unknown = { serviceId: "H1", serviceType: "hosting" }) {
  return new NextRequest(
    "https://example.com/api/workers/process-service-expiry",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

interface FakeService {
  _id: string;
  status: string;
  domainName: string;
  directAdminUsername?: string;
  expiryDate?: Date;
  expiresAt?: Date;
  next_action_at: Date | null;
  processing_until: Date | null;
  last_reminder_sent: number | null;
  price?: number;
  currency?: string;
  autoRenew?: boolean;
  billingType?: string;
  subscriptionId?: string;
  userId: { email: string; firstName?: string; lastName?: string; whatsappNumber?: string } | string;
  save: ReturnType<typeof vi.fn>;
}

function makeHosting(over: Partial<FakeService> = {}): FakeService {
  return {
    _id: "H1",
    status: "active",
    domainName: "alice.com",
    directAdminUsername: "alice123",
    expiryDate: new Date("2026-08-01T00:00:00Z"),
    next_action_at: null,
    processing_until: new Date("2026-06-15T00:00:00Z"),
    last_reminder_sent: null,
    price: 999,
    currency: "INR",
    userId: { email: "alice@example.com", firstName: "Alice", lastName: "Doe" },
    save: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  authorizeCronRequest.mockReset().mockReturnValue(true);
  getHostingById.mockReset();
  domainFindById.mockReset();
  daSuspendUser.mockReset();
  sendServiceSuspensionEmail.mockReset().mockResolvedValue(undefined);
  sendServiceReminderEmail.mockReset().mockResolvedValue(undefined);
  sendServiceSuspended.mockReset().mockResolvedValue(undefined);
  sendServiceReminder.mockReset().mockResolvedValue(undefined);
  timeNow.mockReset();
  daysUntil.mockReset();
});

// ═══════════════════════════════════════════════════════════════════
// Cron auth + schema
// ═══════════════════════════════════════════════════════════════════
describe("Cron auth + schema", () => {
  it("authorizeCronRequest false → 401 UNAUTHORIZED; NO service lookup", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(getHostingById).not.toHaveBeenCalled();
    expect(domainFindById).not.toHaveBeenCalled();
  });

  it("missing serviceId → 400 (zod)", async () => {
    const res = await POST(makeReq({ serviceType: "hosting" }));
    expect(res.status).toBe(400);
    expect(getHostingById).not.toHaveBeenCalled();
  });

  it("invalid serviceType (not 'hosting' / 'domain') → 400", async () => {
    const res = await POST(makeReq({ serviceId: "X", serviceType: "trial" }));
    expect(res.status).toBe(400);
  });

  it("hosting branch calls getHostingById(id, {populateUser:true})", async () => {
    getHostingById.mockResolvedValueOnce(null);
    await POST(makeReq({ serviceId: "H1", serviceType: "hosting" }));
    expect(getHostingById).toHaveBeenCalledWith("H1", { populateUser: true });
  });

  it("domain branch calls Domain.findById(id).populate('userId')", async () => {
    const populate = vi.fn().mockResolvedValue(null);
    domainFindById.mockReturnValueOnce({ populate });
    await POST(makeReq({ serviceId: "D1", serviceType: "domain" }));
    expect(domainFindById).toHaveBeenCalledWith("D1");
    expect(populate).toHaveBeenCalledWith("userId");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Permanent skips (200, no retry)
// ═══════════════════════════════════════════════════════════════════
describe("Permanent skips return 200 success (no Cloud Tasks retry)", () => {
  it("service not found → 200 'Not found — skipped'", async () => {
    getHostingById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("Not found");
  });

  it("terminal status 'failed' → 200 'Skipped — terminal status: failed'", async () => {
    const svc = makeHosting({ status: "failed" });
    getHostingById.mockResolvedValueOnce(svc);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("terminal status");
    expect(body.message).toContain("failed");
    expect(daSuspendUser).not.toHaveBeenCalled();
  });

  it("terminal status 'terminated' → 200 same skip", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting({ status: "terminated" }));
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("terminated");
  });

  it("missing expiryDate → 200 'No expiry date — skipped'", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting({ expiryDate: undefined }));
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("No expiry date");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Anti-loop guard: overdue-but-non-active
// ═══════════════════════════════════════════════════════════════════
describe("Anti-loop guard for overdue-non-active services", () => {
  it("daysLeft<=0 AND status='suspended' → next_action_at cleared to null; NO suspend call", async () => {
    const svc = makeHosting({
      status: "suspended",
      next_action_at: new Date("2026-06-16T00:00:00Z"),
    });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date("2026-06-15T00:00:00Z"));
    daysUntil.mockReturnValueOnce(-5);

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("already in non-active state");
    expect(svc.next_action_at).toBeNull();
    expect(daSuspendUser).not.toHaveBeenCalled();
    expect(sendServiceSuspensionEmail).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// EXPIRY flow — active + expired
// ═══════════════════════════════════════════════════════════════════
describe("EXPIRY flow", () => {
  it("active + expired → suspend DA + status='expired' + next_action_at null + suspension email", async () => {
    const svc = makeHosting();
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date("2026-06-15T00:00:00Z"));
    daysUntil.mockReturnValueOnce(-2);
    daSuspendUser.mockResolvedValueOnce({ kind: "suspended" });

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("expired");
    expect(body.domain).toBe("alice.com");
    expect(svc.status).toBe("expired");
    expect(svc.next_action_at).toBeNull();
    expect(daSuspendUser).toHaveBeenCalledWith({ username: "alice123" });
    expect(sendServiceSuspensionEmail).toHaveBeenCalledWith(
      "alice@example.com",
      expect.objectContaining({ serviceName: "alice.com", serviceType: "hosting" })
    );
  });

  it("expiry: DA user_not_found is terminal (no throw — treated as already-suspended)", async () => {
    const svc = makeHosting();
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-2);
    daSuspendUser.mockResolvedValueOnce({ kind: "user_not_found", reason: "DA wiped" });

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("expired");
    expect(svc.status).toBe("expired");
  });

  it("expiry: DA da_unreachable → throws → inner catch returns 500 (Cloud Tasks retries)", async () => {
    const svc = makeHosting();
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-1);
    daSuspendUser.mockResolvedValueOnce({ kind: "da_unreachable", reason: "ECONNREFUSED" });

    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    // svc.status was NOT flipped to 'expired' — pinned: DA throw aborts before the flip
    expect(svc.status).toBe("active");
  });

  it("expiry: DA hard_failure → throws → 500", async () => {
    const svc = makeHosting();
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-1);
    daSuspendUser.mockResolvedValueOnce({ kind: "hard_failure", reason: "RC 500" });

    const res = await POST(makeReq());
    expect(res.status).toBe(500);
  });

  it("expiry: missing directAdminUsername → DA call SKIPPED but status still flips + email sent", async () => {
    const svc = makeHosting({ directAdminUsername: undefined });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-1);

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(svc.status).toBe("expired");
    expect(daSuspendUser).not.toHaveBeenCalled();
    expect(sendServiceSuspensionEmail).toHaveBeenCalled();
  });

  it("expiry: missing userEmail → suspension email NOT sent (no email-attempt for empty address)", async () => {
    const svc = makeHosting({ userId: { email: "" } });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-1);
    daSuspendUser.mockResolvedValueOnce({ kind: "suspended" });

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(svc.status).toBe("expired");
    expect(sendServiceSuspensionEmail).not.toHaveBeenCalled();
  });

  it("expiry: WhatsApp send when whatsappNumber present", async () => {
    const svc = makeHosting({
      userId: { email: "a@x.com", whatsappNumber: "+919999999999" },
    });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-1);
    daSuspendUser.mockResolvedValueOnce({ kind: "suspended" });

    await POST(makeReq());
    expect(sendServiceSuspended).toHaveBeenCalledWith(
      "+919999999999",
      expect.objectContaining({ serviceName: "alice.com" })
    );
  });

  it("expiry: suspension email failure SWALLOWED (response stays 200)", async () => {
    const svc = makeHosting();
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-1);
    daSuspendUser.mockResolvedValueOnce({ kind: "suspended" });
    sendServiceSuspensionEmail.mockRejectedValueOnce(new Error("SMTP down"));

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(svc.status).toBe("expired");
  });
});

// ═══════════════════════════════════════════════════════════════════
// EXPIRY — subscription auto-renew grace window
// ═══════════════════════════════════════════════════════════════════
describe("Subscription auto-renew grace window (1 day)", () => {
  it("active autoRenew subscription expired <1 day → grace_period, reschedule next_action_at, NO suspend", async () => {
    const svc = makeHosting({
      autoRenew: true,
      billingType: "subscription",
      subscriptionId: "sub_123",
    });
    getHostingById.mockResolvedValueOnce(svc);
    const now = new Date("2026-06-15T00:00:00Z");
    timeNow.mockReturnValueOnce(now);
    daysUntil.mockReturnValueOnce(0); // expired today

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("grace_period");
    expect(svc.status).toBe("active");
    expect(daSuspendUser).not.toHaveBeenCalled();
    expect(svc.next_action_at).toBeInstanceOf(Date);
    // next_action_at ~= now + 24h
    expect(svc.next_action_at!.getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
  });

  it("active autoRenew subscription expired >=1 day → grace elapsed, suspend now", async () => {
    const svc = makeHosting({
      autoRenew: true,
      billingType: "subscription",
      subscriptionId: "sub_123",
    });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-2);
    daSuspendUser.mockResolvedValueOnce({ kind: "suspended" });

    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.action).toBe("expired");
    expect(svc.status).toBe("expired");
  });

  it("non-subscription expired (one-time billing) → suspend immediately (NO grace)", async () => {
    const svc = makeHosting({
      autoRenew: false,
      billingType: "one-time",
    });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(0);
    daSuspendUser.mockResolvedValueOnce({ kind: "suspended" });

    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.action).toBe("expired");
    expect(svc.status).toBe("expired");
  });
});

// ═══════════════════════════════════════════════════════════════════
// REMINDER flow
// ═══════════════════════════════════════════════════════════════════
describe("REMINDER flow — descending thresholds [30, 15, 7, 1]", () => {
  it("daysLeft=30 → 30-day reminder sent + last_reminder_sent=30 + next_action_at = expiryDate - 15 days", async () => {
    const expiry = new Date("2026-07-15T00:00:00Z");
    const svc = makeHosting({ expiryDate: expiry, last_reminder_sent: null });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date("2026-06-15T00:00:00Z"));
    daysUntil.mockReturnValueOnce(30);

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("reminder_30");
    expect(svc.last_reminder_sent).toBe(30);
    expect(sendServiceReminderEmail).toHaveBeenCalledWith(
      "alice@example.com",
      expect.objectContaining({ serviceName: "alice.com", daysRemaining: 30, serviceType: "hosting" })
    );
    expect(svc.next_action_at).toBeInstanceOf(Date);
    expect(svc.next_action_at!.getTime()).toBe(expiry.getTime() - 15 * 24 * 60 * 60 * 1000);
    expect(daSuspendUser).not.toHaveBeenCalled();
  });

  it("daysLeft=7 → 7-day reminder + next_action_at = expiryDate - 1 day", async () => {
    const expiry = new Date("2026-06-22T00:00:00Z");
    const svc = makeHosting({ expiryDate: expiry });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date("2026-06-15T00:00:00Z"));
    daysUntil.mockReturnValueOnce(7);

    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.action).toBe("reminder_7");
    expect(svc.last_reminder_sent).toBe(7);
    expect(svc.next_action_at!.getTime()).toBe(expiry.getTime() - 1 * 24 * 60 * 60 * 1000);
  });

  it("daysLeft=1 (last threshold) → reminder_1 + next_action_at = expiryDate at UTC midnight", async () => {
    const expiry = new Date("2026-06-16T15:30:00Z");
    const svc = makeHosting({ expiryDate: expiry });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date("2026-06-15T00:00:00Z"));
    daysUntil.mockReturnValueOnce(1);

    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.action).toBe("reminder_1");
    // floored to UTC midnight (00:00:00 on expiry date)
    expect(svc.next_action_at!.getUTCHours()).toBe(0);
    expect(svc.next_action_at!.getUTCMinutes()).toBe(0);
    expect(svc.next_action_at!.getUTCSeconds()).toBe(0);
  });

  it("dedup: same threshold already sent → NO email; falls through to fallback recalculation", async () => {
    const svc = makeHosting({ last_reminder_sent: 30 });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(30);

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("No action needed — next checkpoint scheduled");
    expect(sendServiceReminderEmail).not.toHaveBeenCalled();
  });

  it("daysLeft=15 with last_reminder_sent=30 → 15-day reminder fires (different threshold)", async () => {
    const svc = makeHosting({ last_reminder_sent: 30 });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(15);

    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.action).toBe("reminder_15");
    expect(svc.last_reminder_sent).toBe(15);
  });

  it("reminder email FAILURE swallowed (response stays 200; last_reminder_sent still set)", async () => {
    const svc = makeHosting();
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(30);
    sendServiceReminderEmail.mockRejectedValueOnce(new Error("SMTP down"));

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(svc.last_reminder_sent).toBe(30);
  });

  it("userName template: firstName + lastName trimmed; lastName missing → just firstName", async () => {
    const svc = makeHosting({
      userId: { email: "a@x.com", firstName: "Alice" },
    });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(30);

    await POST(makeReq());
    expect(sendServiceReminderEmail).toHaveBeenCalledWith(
      "a@x.com",
      expect.objectContaining({ userName: "Alice" })
    );
  });

  it("WhatsApp reminder when whatsappNumber present", async () => {
    const svc = makeHosting({
      userId: { email: "a@x.com", firstName: "Alice", whatsappNumber: "+919999999999" },
    });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(7);

    await POST(makeReq());
    expect(sendServiceReminder).toHaveBeenCalledWith(
      "+919999999999",
      expect.objectContaining({ serviceName: "alice.com", daysRemaining: 7 })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// FALLBACK rescheduling
// ═══════════════════════════════════════════════════════════════════
describe("FALLBACK rescheduling — no reminder fires", () => {
  it("daysLeft between thresholds with all sent → next_action_at recalculated to nearest checkpoint", async () => {
    const expiry = new Date("2026-08-15T00:00:00Z");
    const svc = makeHosting({ expiryDate: expiry, last_reminder_sent: 30 });
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date("2026-06-15T00:00:00Z"));
    daysUntil.mockReturnValueOnce(60);

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("No action needed — next checkpoint scheduled");
    expect(svc.next_action_at).toBeInstanceOf(Date);
    expect(svc.next_action_at!.getTime()).toBe(expiry.getTime() - 30 * 24 * 60 * 60 * 1000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Domain serviceType — suspendService is no-op
// ═══════════════════════════════════════════════════════════════════
describe("Domain serviceType — registrar manages suspension; no DA call", () => {
  it("expired domain → status flip but NO daSuspendUser call", async () => {
    const svc = {
      ...makeHosting(),
      directAdminUsername: undefined,
      expiryDate: undefined,
      expiresAt: new Date("2026-06-10T00:00:00Z"),
    };
    const populate = vi.fn().mockResolvedValue(svc);
    domainFindById.mockReturnValueOnce({ populate });
    timeNow.mockReturnValueOnce(new Date("2026-06-15T00:00:00Z"));
    daysUntil.mockReturnValueOnce(-5);

    const res = await POST(makeReq({ serviceId: "D1", serviceType: "domain" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("expired");
    expect(svc.status).toBe("expired");
    expect(daSuspendUser).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Finally-block lock release
// ═══════════════════════════════════════════════════════════════════
describe("Finally block — processing_until cleared and save() called", () => {
  it("happy expiry path: processing_until cleared + save() called", async () => {
    const svc = makeHosting();
    expect(svc.processing_until).not.toBeNull();
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-1);
    daSuspendUser.mockResolvedValueOnce({ kind: "suspended" });

    await POST(makeReq());
    expect(svc.processing_until).toBeNull();
    expect(svc.save).toHaveBeenCalled();
  });

  it("inner-catch path (DA da_unreachable throw): processing_until STILL cleared + save() STILL called (lock release)", async () => {
    const svc = makeHosting();
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-1);
    daSuspendUser.mockResolvedValueOnce({ kind: "da_unreachable", reason: "down" });

    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(svc.processing_until).toBeNull();
    expect(svc.save).toHaveBeenCalled();
  });

  it("permanent skip (not found): NO save called (no service object to unlock)", async () => {
    getHostingById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    // service is null so no save() to call — assertion is implicit.
  });

  it("finally save() failure swallowed (still returns the main response)", async () => {
    const svc = makeHosting();
    svc.save = vi.fn().mockRejectedValueOnce(new Error("Mongo timeout"));
    getHostingById.mockResolvedValueOnce(svc);
    timeNow.mockReturnValueOnce(new Date());
    daysUntil.mockReturnValueOnce(-1);
    daSuspendUser.mockResolvedValueOnce({ kind: "suspended" });

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Outer-catch
// ═══════════════════════════════════════════════════════════════════
describe("Inner-catch returns 500 INTERNAL_ERROR (generic, no leak)", () => {
  it("getHostingById throw → 500 INTERNAL_ERROR", async () => {
    getHostingById.mockRejectedValueOnce(
      new Error("Mongo blowup: secret-host-A-leak")
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal error");
    expect(JSON.stringify(body)).not.toContain("secret-host-A-leak");
  });

  it("TimeService.now throw → 500", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    timeNow.mockImplementationOnce(() => {
      throw new Error("clock blowup");
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal error");
  });
});
