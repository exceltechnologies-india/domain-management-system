/**
 * Tests for `app/api/cron/pending-sweeper/route.ts` (slice 7hq, part 2).
 *
 * Daily digest cron: scans PendingDomain + PendingHosting for records
 * stuck >24h, emails admin a single sorted digest with severity flags.
 *
 * Threat model:
 *  - **Silent failures hidden by archived flag**: PendingDomain rows
 *    with `isArchived: true` are admin-curated as resolved. Pinned:
 *    Mongo filter excludes them.
 *  - **Email failure poisoning the cron response**: if the digest
 *    email throws, the cron MUST still return 200 with counts. A
 *    refactor that re-throws would back the external scheduler off,
 *    losing the daily cadence.
 *  - **Severity inversion**: CRITICAL vs WARN sort, then age — if a
 *    refactor flipped the sort, admin would see WARN-then-CRITICAL
 *    in their inbox, easily missing the high-stakes rows.
 *
 * Other pins:
 *  - Dual auth: cron-secret OR admin session
 *  - PendingDomain filter: status ∈ {pending, processing, failed},
 *    isArchived $ne true, createdAt < warnCutoff (now − 24h)
 *  - CRITICAL rules: age > 7d OR verificationAttempts > 5
 *  - Sort: CRITICAL first, then by age desc
 *  - Subject branches: with CRITICAL count → "N CRITICAL + M stuck",
 *    else → "M stuck"
 *  - Empty result → email NOT sent; response { checked:0, critical:0, warn:0 }
 *  - Response shape: { checked, critical, warn }
 *  - Outer catch → 500 INTERNAL_ERROR; no sentinel leak
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { isAdmin } }));

const sendAdminNotification = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendAdminNotification },
}));

const listStuckPendingHostings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-hostings", () => ({
  listStuckPendingHostings,
}));

const pendingDomainFindLean = vi.hoisted(() => vi.fn());
const pendingDomainFindSelect = vi.hoisted(() => vi.fn());
const pendingDomainFind = vi.hoisted(() => vi.fn());
vi.mock("@/models/PendingDomain", () => ({
  default: { find: pendingDomainFind },
}));

vi.mock("@/lib/mongodb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/cron/pending-sweeper/route";

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest("https://example.com/api/cron/pending-sweeper", {
    method: "GET",
    headers,
  });
}

function setupMongoChain(rows: unknown[]) {
  pendingDomainFindLean.mockResolvedValue(rows);
  pendingDomainFindSelect.mockReturnValue({ lean: pendingDomainFindLean });
  pendingDomainFind.mockReturnValue({ select: pendingDomainFindSelect });
}

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
  authorizeCronRequest.mockReset();
  isAdmin.mockReset();
  sendAdminNotification.mockReset().mockResolvedValue(undefined);
  listStuckPendingHostings.mockReset().mockResolvedValue([]);
  pendingDomainFindLean.mockReset();
  pendingDomainFindSelect.mockReset();
  pendingDomainFind.mockReset();
  setupMongoChain([]);
});

describe("Dual auth", () => {
  it("no cron-secret + non-admin → 401 UNAUTHORIZED; no DB read", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(pendingDomainFind).not.toHaveBeenCalled();
  });

  it("valid cron-secret → proceeds (admin check skipped)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    const res = await GET(makeReq({ "x-cron-secret": "ok" }));
    expect(res.status).toBe(200);
    expect(isAdmin).not.toHaveBeenCalled();
  });

  it("cron-secret fails but admin session → proceeds", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    isAdmin.mockResolvedValueOnce(true);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });
});

describe("PendingDomain query shape", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("filter: isArchived $ne true; status in [pending, processing, failed]; createdAt < 24h-cutoff", async () => {
    setupMongoChain([]);
    await GET(makeReq());
    expect(pendingDomainFind).toHaveBeenCalledTimes(1);
    const filter = pendingDomainFind.mock.calls[0][0];
    expect(filter.isArchived).toEqual({ $ne: true });
    expect(filter.status).toEqual({
      $in: ["pending", "processing", "failed"],
    });
    expect(filter.createdAt.$lt).toBeInstanceOf(Date);
    const cutoffMs = (filter.createdAt.$lt as Date).getTime();
    // Within tolerance of (Date.now() - 24h)
    expect(cutoffMs).toBeGreaterThanOrEqual(Date.now() - DAY - 1000);
    expect(cutoffMs).toBeLessThanOrEqual(Date.now() - DAY + 1000);
  });

  it("select projection pinned to 7 fields", async () => {
    setupMongoChain([]);
    await GET(makeReq());
    expect(pendingDomainFindSelect).toHaveBeenCalledWith(
      "domainName status createdAt verificationAttempts reason orderId userId"
    );
  });
});

describe("Severity escalation rules", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("PendingDomain 25h old, attempts=0 → WARN", async () => {
    setupMongoChain([
      {
        _id: "D1",
        domainName: "x.com",
        status: "pending",
        createdAt: new Date(NOW - 25 * HOUR),
        verificationAttempts: 0,
        reason: "test",
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body).toEqual({ checked: 1, critical: 0, warn: 1 });
  });

  it("PendingDomain 8d old → CRITICAL via age rule", async () => {
    setupMongoChain([
      {
        _id: "D2",
        domainName: "x.com",
        status: "pending",
        createdAt: new Date(NOW - 8 * DAY),
        verificationAttempts: 0,
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.critical).toBe(1);
    expect(body.warn).toBe(0);
  });

  it("PendingDomain 25h old + verificationAttempts=6 → CRITICAL via attempt rule", async () => {
    setupMongoChain([
      {
        _id: "D3",
        domainName: "x.com",
        status: "failed",
        createdAt: new Date(NOW - 25 * HOUR),
        verificationAttempts: 6,
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.critical).toBe(1);
  });

  it("BOUNDARY: verificationAttempts = 5 exactly → still WARN (rule is > 5)", async () => {
    setupMongoChain([
      {
        _id: "D4",
        domainName: "x.com",
        status: "failed",
        createdAt: new Date(NOW - 25 * HOUR),
        verificationAttempts: 5,
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.warn).toBe(1);
    expect(body.critical).toBe(0);
  });

  it("PendingHosting 8d old → CRITICAL via age rule", async () => {
    setupMongoChain([]);
    listStuckPendingHostings.mockResolvedValueOnce([
      {
        _id: "H1",
        domain: "h.com",
        status: "failed",
        createdAt: new Date(NOW - 8 * DAY),
        error: "DA refused",
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.critical).toBe(1);
  });
});

describe("Digest email content", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("subject includes CRITICAL count when > 0", async () => {
    setupMongoChain([
      {
        _id: "D1",
        domainName: "crit.com",
        status: "failed",
        createdAt: new Date(NOW - 8 * DAY),
        verificationAttempts: 0,
      },
      {
        _id: "D2",
        domainName: "warn.com",
        status: "pending",
        createdAt: new Date(NOW - 25 * HOUR),
        verificationAttempts: 0,
      },
    ]);
    await GET(makeReq());
    expect(sendAdminNotification).toHaveBeenCalledTimes(1);
    const [, subject] = sendAdminNotification.mock.calls[0];
    expect(subject).toContain("1 CRITICAL");
    expect(subject).toContain("1 stuck");
  });

  it("subject is WARN-only count when no CRITICAL", async () => {
    setupMongoChain([
      {
        _id: "D1",
        domainName: "warn.com",
        status: "pending",
        createdAt: new Date(NOW - 25 * HOUR),
      },
    ]);
    await GET(makeReq());
    const [, subject] = sendAdminNotification.mock.calls[0];
    expect(subject).not.toContain("CRITICAL");
    expect(subject).toContain("1 stuck");
  });

  it("digest is sorted: CRITICAL first, then by ageHours desc", async () => {
    setupMongoChain([
      {
        _id: "WARN-YOUNG",
        domainName: "warn-young.com",
        status: "pending",
        createdAt: new Date(NOW - 25 * HOUR),
      },
      {
        _id: "CRIT-OLD",
        domainName: "crit-old.com",
        status: "failed",
        createdAt: new Date(NOW - 30 * DAY),
      },
      {
        _id: "CRIT-NEWER",
        domainName: "crit-newer.com",
        status: "failed",
        createdAt: new Date(NOW - 10 * DAY),
      },
    ]);
    await GET(makeReq());
    const records = sendAdminNotification.mock.calls[0][3]
      .records as Array<{ identifier: string; severity: string }>;
    // CRITICAL first (older one first within CRITICAL), then WARN
    expect(records.map((r) => r.identifier)).toEqual([
      "crit-old.com",
      "crit-newer.com",
      "warn-young.com",
    ]);
  });
});

describe("Empty-result behaviour", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("no stuck rows → email NOT sent; response zero across the board", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ checked: 0, critical: 0, warn: 0 });
    expect(sendAdminNotification).not.toHaveBeenCalled();
  });
});

describe("Email-failure swallow", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("digest email throw → cron still returns 200; sentinel NOT leaked", async () => {
    setupMongoChain([
      {
        _id: "D1",
        domainName: "x.com",
        status: "pending",
        createdAt: new Date(NOW - 25 * HOUR),
      },
    ]);
    sendAdminNotification.mockRejectedValueOnce(
      new Error("SMTP relay down — credentials zoho_oauth_LEAK_ME")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checked).toBe(1);
    expect(JSON.stringify(body)).not.toContain("zoho_oauth_LEAK_ME");
  });
});

describe("Outer catch", () => {
  it("PendingDomain.find throw → 500 INTERNAL_ERROR; sentinel NOT leaked", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    pendingDomainFind.mockImplementation(() => {
      throw new Error("Mongo down — $2a$12$BCRYPT_LEAK_ME");
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_LEAK_ME");
  });
});
