/**
 * Tests for `@/lib/integrations/resellerclub/renew-domain` (rescan-4
 * slice 7dj). Pins:
 *  - RC success → outcome from classify (renewed shape)
 *  - hard_failure response → error log
 *  - thrown error with BALANCE_PENDING_FRAGMENTS message → balance_pending
 *    (no other branch swallows balance failures; this short-circuit
 *    keeps the cron-retry path working when the SDK throws instead of
 *    returning {status:"error"})
 *  - other thrown errors → hard_failure with the message
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.RESELLERCLUB_API_URL = "https://test-api.resellerclub.example.com";
  process.env.RESELLERCLUB_ID = "test-id";
  process.env.RESELLERCLUB_SECRET = "test-secret";
});

const rcRenewMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { renewDomain: rcRenewMock },
}));

const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: loggerError, info: vi.fn(), warn: vi.fn() },
}));

import { renewDomain } from "@/lib/integrations/resellerclub/renew-domain";

beforeEach(() => {
  rcRenewMock.mockReset();
  loggerError.mockReset();
});

describe("renewDomain wrapper", () => {
  it("RC success with order-id → {kind:'renewed', orderId, ...}", async () => {
    rcRenewMock.mockResolvedValueOnce({
      status: "success",
      data: { entityid: "ord_42", sellingprice: 1200, currencysymbol: "INR" },
    });
    const result = await renewDomain({ domainName: "example.com", years: 1 });
    expect(result.kind).toBe("renewed");
    expect(rcRenewMock).toHaveBeenCalledWith("example.com", 1);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("hard_failure response → error log emitted", async () => {
    rcRenewMock.mockResolvedValueOnce({
      status: "ERROR",
      message: "Order is locked by registry",
    });
    const result = await renewDomain({ domainName: "example.com", years: 1 });
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatch(/example\.com/);
  });

  it("thrown error matching BALANCE_PENDING_FRAGMENTS → {kind:'balance_pending'} (no hard_failure)", async () => {
    // 'insufficient balance' is in BALANCE_PENDING_FRAGMENTS verbatim.
    rcRenewMock.mockRejectedValueOnce(new Error("Insufficient balance on reseller account"));
    const result = await renewDomain({ domainName: "example.com", years: 1 });
    expect(result.kind).toBe("balance_pending");
    // Error is still logged before classification.
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("thrown error not matching balance fragments → {kind:'hard_failure', reason}", async () => {
    rcRenewMock.mockRejectedValueOnce(new Error("Request failed with status 500"));
    const result = await renewDomain({ domainName: "example.com", years: 1 });
    expect(result.kind).toBe("hard_failure");
    if (result.kind === "hard_failure") {
      expect(result.reason).toMatch(/status 500/);
    }
    expect(loggerError).toHaveBeenCalled();
  });

  it("thrown non-Error value still classifies (String coercion)", async () => {
    rcRenewMock.mockRejectedValueOnce("plain string error");
    const result = await renewDomain({ domainName: "example.com", years: 1 });
    expect(result.kind).toBe("hard_failure");
  });

  it("forwards the years arg through to the SDK call", async () => {
    rcRenewMock.mockResolvedValueOnce({
      status: "success",
      data: { entityid: "ord_42", sellingprice: 1200, currencysymbol: "INR" },
    });
    await renewDomain({ domainName: "example.com", years: 5 });
    expect(rcRenewMock).toHaveBeenCalledWith("example.com", 5);
  });
});

/**
 * How far did the request get?
 *
 * A renewal is not known to be idempotent — whether a second call to
 * ResellerClub adds a second year is an open question (Todos.md §E). So the
 * caller cannot be handed one undifferentiated `hard_failure`: "nothing left
 * the machine" and "the socket died after the POST" demand opposite responses,
 * and the route picks its HTTP status from this field.
 */
describe("hard_failure carries how far the request got", () => {
  const withCode = (code: string) => Object.assign(new Error(code), { code });

  it("a parsed RC refusal is `responded` — we know it did not happen", async () => {
    rcRenewMock.mockResolvedValueOnce({ status: "error", message: "domain not in account" });
    const out = await renewDomain({ domainName: "x.com", years: 1 });
    expect(out.kind).toBe("hard_failure");
    if (out.kind === "hard_failure") expect(out.transport).toBe("responded");
  });

  it.each(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"])(
    "%s proves no connection was established → not_sent",
    async (code) => {
      rcRenewMock.mockRejectedValueOnce(withCode(code));
      const out = await renewDomain({ domainName: "x.com", years: 1 });
      if (out.kind === "hard_failure") expect(out.transport).toBe("not_sent");
      else throw new Error(`expected hard_failure, got ${out.kind}`);
    }
  );

  it.each(["ECONNRESET", "ETIMEDOUT"])(
    "%s does NOT prove that → sent_unknown, and the year may already be bought",
    async (code) => {
      rcRenewMock.mockRejectedValueOnce(withCode(code));
      const out = await renewDomain({ domainName: "x.com", years: 1 });
      if (out.kind === "hard_failure") expect(out.transport).toBe("sent_unknown");
      else throw new Error(`expected hard_failure, got ${out.kind}`);
    }
  );

  it("an error with no code at all is sent_unknown, not not_sent", async () => {
    // Fails toward "a human checks", which is the safe direction for a spend
    // that cannot be taken back.
    rcRenewMock.mockRejectedValueOnce(new Error("something went wrong"));
    const out = await renewDomain({ domainName: "x.com", years: 1 });
    if (out.kind === "hard_failure") expect(out.transport).toBe("sent_unknown");
    else throw new Error(`expected hard_failure, got ${out.kind}`);
  });

  it("balance_pending is still balance_pending, not a transport question", async () => {
    // It has its own meaning — RC queued it — and must not be swept into the
    // ambiguous bucket, or a normal top-up wait would read as a lost renewal.
    rcRenewMock.mockRejectedValueOnce(new Error("Insufficient balance in your account"));
    const out = await renewDomain({ domainName: "x.com", years: 1 });
    expect(out.kind).toBe("balance_pending");
  });
});
