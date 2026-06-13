/**
 * Tests for `app/api/workers/check-domain-watch/route.ts` (slice 7hu, part 2).
 *
 * Daily fan-out worker: checks each customer's "watch this domain"
 * subscription against ResellerClub, emails them + removes the watch
 * when the domain becomes available.
 *
 * Threat model:
 *  - **Open machine endpoint**: this is fired from the daily-scheduler
 *    cron — it must NOT accept admin sessions or any other auth path.
 *    Pinned: cron-secret-ONLY (no AuthService.isAdmin fallback,
 *    unlike other crons). Closes the "admin manually triggers RC
 *    fan-out from the browser" abuse path.
 *  - **Duplicate notifications**: a refactor that forgets the
 *    `removeWatchById` call would re-email the customer every day
 *    until they delete the watch manually. Pinned: notification AND
 *    removal both required for "notified" outcome.
 *  - **One bad watch killing the batch**: RC throw on watch #3 must
 *    NOT abort watches #4–100. Pinned via Promise.allSettled.
 *
 * Other pins:
 *  - BATCH_SIZE=100
 *  - WATCH_CONCURRENCY=5
 *  - searchDomain match: exact lowercase preferred
 *  - recordWatchCheck called for EVERY watch (status='available'/'taken'),
 *    regardless of email outcome
 *  - email throw is SWALLOWED (removal still happens — the customer
 *    will see the watch is gone, the mailbox bounce is logged)
 *  - Empty list short-circuit: { success:true, checked:0, notified:0 }
 *  - Outer catch → 500 INTERNAL_ERROR; no sentinel leak
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const listWatchesForCron = vi.hoisted(() => vi.fn());
const recordWatchCheck = vi.hoisted(() => vi.fn());
const removeWatchById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/domain-watches", () => ({
  listWatchesForCron,
  recordWatchCheck,
  removeWatchById,
}));

const searchDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { searchDomain },
}));

const sendDomainAvailableEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendDomainAvailableEmail },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/workers/check-domain-watch/route";

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest(
    "https://example.com/api/workers/check-domain-watch",
    { method: "POST", headers }
  );
}

function makeWatch(
  id: string,
  domainName: string,
  user?: { email?: string; firstName?: string; lastName?: string } | null
) {
  return {
    _id: id,
    domainName,
    userId: user,
  };
}

beforeEach(() => {
  authorizeCronRequest.mockReset();
  listWatchesForCron.mockReset().mockResolvedValue([]);
  recordWatchCheck.mockReset().mockResolvedValue(undefined);
  removeWatchById.mockReset().mockResolvedValue(undefined);
  searchDomain.mockReset();
  sendDomainAvailableEmail.mockReset().mockResolvedValue(undefined);
});

describe("Auth — cron-secret ONLY (machine-only)", () => {
  it("no cron-secret → 401 UNAUTHORIZED; NO list read (NO admin-session fallback)", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(listWatchesForCron).not.toHaveBeenCalled();
  });

  it("valid cron-secret → proceeds", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    const res = await POST(makeReq({ "x-cron-secret": "ok" }));
    expect(res.status).toBe(200);
  });
});

describe("Empty-list short-circuit", () => {
  it("no watches → { success:true, checked:0, notified:0 }; no RC call", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body).toEqual({ success: true, checked: 0, notified: 0 });
    expect(searchDomain).not.toHaveBeenCalled();
  });
});

describe("BATCH_SIZE + concurrency", () => {
  it("listWatchesForCron called with BATCH_SIZE=100", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    await POST(makeReq());
    expect(listWatchesForCron).toHaveBeenCalledWith(100);
  });

  it("WATCH_CONCURRENCY=5: 12 watches → in-flight peak ≤5, all processed", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    const watches = Array.from({ length: 12 }, (_, i) =>
      makeWatch(`W${i}`, `d${i}.com`)
    );
    listWatchesForCron.mockResolvedValueOnce(watches);
    let inFlight = 0;
    let peak = 0;
    searchDomain.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [];
    });

    const res = await POST(makeReq());
    expect(peak).toBeLessThanOrEqual(5);
    expect(searchDomain).toHaveBeenCalledTimes(12);
    expect(res.status).toBe(200);
  });
});

describe("searchDomain match selection", () => {
  it("exact lowercase match preferred over arbitrary order", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listWatchesForCron.mockResolvedValueOnce([
      makeWatch("W1", "EXAMPLE.com"),
    ]);
    searchDomain.mockResolvedValueOnce([
      { domainName: "other.com", available: true },
      { domainName: "EXAMPLE.com", available: false },
    ]);
    await POST(makeReq());
    // Domain found = EXAMPLE.com (taken). recordWatchCheck called with 'taken'
    expect(recordWatchCheck).toHaveBeenCalledWith("W1", "taken");
    expect(sendDomainAvailableEmail).not.toHaveBeenCalled();
  });

  it("no match in results → treated as 'taken' (not available)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listWatchesForCron.mockResolvedValueOnce([makeWatch("W1", "x.com")]);
    searchDomain.mockResolvedValueOnce([]);
    await POST(makeReq());
    expect(recordWatchCheck).toHaveBeenCalledWith("W1", "taken");
  });
});

describe("Notify-once: email + removal semantics", () => {
  it("domain available + user has email → sendDomainAvailableEmail + removeWatchById; counted notified", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listWatchesForCron.mockResolvedValueOnce([
      makeWatch("W1", "available.com", {
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Smith",
      }),
    ]);
    searchDomain.mockResolvedValueOnce([
      { domainName: "available.com", available: true },
    ]);

    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.notified).toBe(1);
    expect(sendDomainAvailableEmail).toHaveBeenCalledWith(
      "alice@example.com",
      "available.com",
      "Alice Smith"
    );
    expect(removeWatchById).toHaveBeenCalledWith("W1");
    expect(recordWatchCheck).toHaveBeenCalledWith("W1", "available");
  });

  it("domain available BUT user has no email → recordWatchCheck still happens; NO email, NO removal", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listWatchesForCron.mockResolvedValueOnce([
      makeWatch("W1", "available.com", { email: undefined }),
    ]);
    searchDomain.mockResolvedValueOnce([
      { domainName: "available.com", available: true },
    ]);

    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.notified).toBe(0);
    expect(sendDomainAvailableEmail).not.toHaveBeenCalled();
    expect(removeWatchById).not.toHaveBeenCalled();
    expect(recordWatchCheck).toHaveBeenCalledWith("W1", "available");
  });

  it("domain still taken → no email, no removal; checked++ only", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listWatchesForCron.mockResolvedValueOnce([
      makeWatch("W1", "taken.com", { email: "alice@example.com" }),
    ]);
    searchDomain.mockResolvedValueOnce([
      { domainName: "taken.com", available: false },
    ]);

    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.checked).toBe(1);
    expect(body.notified).toBe(0);
    expect(sendDomainAvailableEmail).not.toHaveBeenCalled();
    expect(removeWatchById).not.toHaveBeenCalled();
  });

  it("email-send THROW → SWALLOWED; removeWatchById STILL called; counted notified", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listWatchesForCron.mockResolvedValueOnce([
      makeWatch("W1", "available.com", {
        email: "alice@example.com",
        firstName: "Alice",
      }),
    ]);
    searchDomain.mockResolvedValueOnce([
      { domainName: "available.com", available: true },
    ]);
    sendDomainAvailableEmail.mockRejectedValueOnce(
      new Error("SMTP relay down — zoho_oauth_LEAK_ME")
    );

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notified).toBe(1);
    expect(removeWatchById).toHaveBeenCalledWith("W1");
    expect(JSON.stringify(body)).not.toContain("zoho_oauth_LEAK_ME");
  });

  it("first/last name fallback: only firstName → 'Alice' (no trailing space)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listWatchesForCron.mockResolvedValueOnce([
      makeWatch("W1", "available.com", {
        email: "alice@example.com",
        firstName: "Alice",
        // no lastName
      }),
    ]);
    searchDomain.mockResolvedValueOnce([
      { domainName: "available.com", available: true },
    ]);
    await POST(makeReq());
    expect(sendDomainAvailableEmail).toHaveBeenCalledWith(
      "alice@example.com",
      "available.com",
      "Alice"
    );
  });

  it("no firstName → userName passes as undefined (not empty string)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listWatchesForCron.mockResolvedValueOnce([
      makeWatch("W1", "available.com", { email: "x@y.com" }),
    ]);
    searchDomain.mockResolvedValueOnce([
      { domainName: "available.com", available: true },
    ]);
    await POST(makeReq());
    expect(sendDomainAvailableEmail).toHaveBeenCalledWith(
      "x@y.com",
      "available.com",
      undefined
    );
  });
});

describe("Per-watch failure isolation", () => {
  it("RC throw on one watch → counted as error; OTHER watches still complete", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listWatchesForCron.mockResolvedValueOnce([
      makeWatch("W1", "fail.com", { email: "a@b.com" }),
      makeWatch("W2", "ok.com", { email: "c@d.com" }),
    ]);
    searchDomain
      .mockRejectedValueOnce(new Error("RC blip"))
      .mockResolvedValueOnce([{ domainName: "ok.com", available: true }]);

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toBe(1);
    expect(body.checked).toBe(1);
    expect(body.notified).toBe(1);
    // W1 was NEVER recorded (the throw happened inside the chunk before
    // recordWatchCheck). W2 was processed normally.
    expect(recordWatchCheck).toHaveBeenCalledWith("W2", "available");
    expect(removeWatchById).toHaveBeenCalledWith("W2");
  });
});

describe("Outer catch", () => {
  it("listWatchesForCron throw → 500 INTERNAL_ERROR; bcrypt sentinel NOT leaked", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listWatchesForCron.mockRejectedValueOnce(
      new Error("Mongo down — $2a$12$BCRYPT_LEAK_ME")
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_LEAK_ME");
  });
});
