/**
 * domain.renew — Phase 8, the first rupee that does not come back.
 *
 * Threat model, in the order these cost money:
 *  - **A second renewal must be refused, not committed.** RC's `exp-date` is an
 *    optimistic-concurrency guard and our own wrapper defeated it by re-reading
 *    the expiry immediately before sending. This command sends the caller's
 *    OBSERVED expiry verbatim, so a domain renewed since the caller looked is
 *    caught before any money moves.
 *  - **It must never look the expiry up for you.** A convenience lookup here
 *    would reinstate the exact bug: the fresh value always matches, so the
 *    guard always passes.
 *  - **Test mode must not spend.** The dry run reads the order and the expiry
 *    and stops.
 *  - **A lost response must hold the claim**, because the renewal may have
 *    landed. The transport comes from the raw call, which tracks whether the
 *    POST was attempted.
 *  - **The reconciler must be exact.** Moved past the baseline → done.
 *    Unchanged → not_done. Anything else → unknown, because settling a money
 *    command on a nonsensical reading is worse than asking a human.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getDomainOrderId = vi.fn();
const getDomainDetails = vi.fn();
const rcRenew = vi.fn();
const applyDomainRenewal = vi.fn();

vi.mock("@/lib/integrations/resellerclub", () => ({
  getDomainOrderId: (...a: unknown[]) => getDomainOrderId(...a),
  getDomainDetails: (...a: unknown[]) => getDomainDetails(...a),
}));
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { renewDomain: (...a: unknown[]) => rcRenew(...a) },
}));
vi.mock("@/lib/services/domains", () => ({
  applyDomainRenewal: (...a: unknown[]) => applyDomainRenewal(...a),
}));
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  renewDomainCommand,
  reconcileRenew,
} from "@/lib/integrations/engine-handlers-domain";
import { transportOf } from "@/lib/integrations/engine-attempt";

/** 1 Jan 2027 and 1 Jan 2028, epoch seconds. */
const BEFORE = 1798761600;
const AFTER = 1830297600;

const found = (endtime: number) => ({ kind: "found" as const, details: { endtime: String(endtime) } });

const ctx = (
  mode: "test" | "live",
  payload: Record<string, unknown> = { years: 1, expiryBefore: BEFORE }
) => ({ commandId: "c1", subject: "acme.in", mode, payload });

beforeEach(() => {
  getDomainOrderId.mockReset().mockResolvedValue({ kind: "found", orderId: "ORD-1" });
  getDomainDetails.mockReset().mockResolvedValue(found(BEFORE));
  rcRenew.mockReset().mockResolvedValue({ status: "success", transport: "responded" });
  applyDomainRenewal.mockReset().mockResolvedValue(true);
});

describe("the payload is checked before anything is read", () => {
  it.each([0, 11, 1.5, "two", undefined])("years=%p is refused", async (years) => {
    await expect(renewDomainCommand(ctx("live", { years, expiryBefore: BEFORE }))).rejects.toThrow(
      /"years" must be a whole number from 1 to 10/
    );
    expect(rcRenew).not.toHaveBeenCalled();
  });

  it("a missing expiryBefore is refused, and the message says WHY it is not optional", async () => {
    const err = await renewDomainCommand(ctx("live", { years: 1 })).catch((e) => e);
    expect(err.message).toMatch(/"expiryBefore" is required/);
    // The reason matters more than the rule: somebody will want to "helpfully"
    // default it, and that is the bug.
    expect(err.message).toMatch(/retry buys a second year/i);
    expect(err.message).toMatch(/Read it, then send what you read/);
    expect(getDomainOrderId).not.toHaveBeenCalled();
  });
});

describe("what actually stops a second renewal", () => {
  /**
   * A red-check corrected this file's first version, and the correction is
   * worth keeping visible.
   *
   * The test here originally read "sends the CALLER's expiry, not the one it
   * just read", and claimed to be the assertion that catches the whole defect.
   * It was vacuous: the handler only reaches the send when
   * `current === expiryBefore`, so the two values are identical by then and
   * swapping one for the other changes nothing. Mutating the source to pass the
   * freshly-read value left this green.
   *
   * The protection is not which variable is passed — it is the EQUALITY GUARD
   * above it, which is what the "already renewed" test below actually pins.
   * Removing that guard turns this file red; changing the variable does not,
   * and should not, because with the guard in place they are the same number.
   */
  it("sends the caller's declared baseline, which the guard has made equal to the truth", async () => {
    getDomainDetails.mockResolvedValue(found(BEFORE));
    await renewDomainCommand(ctx("live"));
    expect(rcRenew).toHaveBeenCalledWith("ORD-1", 1, BEFORE);
  });
});

describe("a domain already renewed since the caller looked", () => {
  it("is REFUSED, spends nothing, and says how to ask for it deliberately", async () => {
    getDomainDetails.mockResolvedValue(found(AFTER));
    const err = await renewDomainCommand(ctx("live")).catch((e) => e);
    expect(err.message).toMatch(/has already been renewed since you read it/);
    expect(err.message).toMatch(/Nothing was spent/);
    // §24: there is a way to proceed, and it names the cost of proceeding.
    expect(err.message).toMatch(new RegExp(`expiryBefore=${AFTER}`));
    expect(err.message).toMatch(/second year on top/);
    expect(rcRenew).not.toHaveBeenCalled();
  });

  it("is unbranded, so the route reads not_sent and releases the subject", async () => {
    getDomainDetails.mockResolvedValue(found(AFTER));
    const err = await renewDomainCommand(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBeNull();
  });

  it("an expiry EARLIER than the baseline is refused rather than guessed at", async () => {
    getDomainDetails.mockResolvedValue(found(BEFORE - 86400));
    await expect(renewDomainCommand(ctx("live"))).rejects.toThrow(/EARLIER than the/);
    expect(rcRenew).not.toHaveBeenCalled();
  });
});

describe("reads that fail stop the command before it spends", () => {
  it("no order at ResellerClub", async () => {
    getDomainOrderId.mockResolvedValue({ kind: "not_found", reason: "no such order" });
    await expect(renewDomainCommand(ctx("live"))).rejects.toThrow(/no order for acme.in/);
    expect(rcRenew).not.toHaveBeenCalled();
  });

  it("details unreadable", async () => {
    getDomainDetails.mockResolvedValue({ kind: "hard_failure", reason: "RC 500" });
    await expect(renewDomainCommand(ctx("live"))).rejects.toThrow(/nothing was\s+renewed|nothing was renewed/);
    expect(rcRenew).not.toHaveBeenCalled();
  });

  it("details present but with no usable expiry", async () => {
    getDomainDetails.mockResolvedValue({ kind: "found", details: {} });
    await expect(renewDomainCommand(ctx("live"))).rejects.toThrow(/did not return a usable expiry/);
    expect(rcRenew).not.toHaveBeenCalled();
  });
});

describe("test mode", () => {
  it("reads and reports, and spends nothing", async () => {
    const { result } = await renewDomainCommand(ctx("test"));
    expect(result).toMatchObject({ ok: true, changed: false, dryRun: true, orderId: "ORD-1" });
    expect(String(result.note)).toMatch(/does not come back/);
    expect(rcRenew).not.toHaveBeenCalled();
    expect(applyDomainRenewal).not.toHaveBeenCalled();
  });
});

describe("a live renewal", () => {
  it("renews, reads the new expiry back, and records it canonically", async () => {
    getDomainDetails
      .mockResolvedValueOnce(found(BEFORE)) // the pre-flight comparison
      .mockResolvedValueOnce(found(AFTER)); // the read-back
    const { result } = await renewDomainCommand(ctx("live"));

    expect(rcRenew).toHaveBeenCalledWith("ORD-1", 1, BEFORE);
    // Written from RC's answer, never computed — a renewal extends the CURRENT
    // expiry, so now + years would be wrong by whatever was left.
    expect(applyDomainRenewal).toHaveBeenCalledWith({
      domainName: "acme.in",
      newExpiresAt: new Date(AFTER * 1000),
    });
    expect(result).toMatchObject({ changed: true, recorded: true, expiryAfter: AFTER });
  });

  it("still reports success when the read-back fails — the renewal DID happen", async () => {
    // Reporting failure here is how a customer buys a second year.
    getDomainDetails
      .mockResolvedValueOnce(found(BEFORE))
      .mockResolvedValueOnce({ kind: "hard_failure", reason: "RC 500" });
    const { result } = await renewDomainCommand(ctx("live"));
    expect(result).toMatchObject({ ok: true, changed: true, recorded: false });
    expect(applyDomainRenewal).not.toHaveBeenCalled();
  });

  it("a refusal carries the transport the raw call worked out", async () => {
    rcRenew.mockResolvedValue({ status: "error", message: "insufficient funds", transport: "responded" });
    const err = await renewDomainCommand(ctx("live")).catch((e) => e);
    expect(err.message).toMatch(/insufficient funds/);
    expect(transportOf(err)).toBe("responded");
  });

  it("a lost response is sent_unknown, so the claim is HELD", async () => {
    // The renewal may have landed. Releasing the subject here is how the next
    // caller buys the second year.
    rcRenew.mockResolvedValue({ status: "error", message: "socket hang up", transport: "sent_unknown" });
    const err = await renewDomainCommand(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBe("sent_unknown");
  });

  it("a transport-less error response defaults to sent_unknown, not not_sent", async () => {
    // Fail toward holding the subject: the safe direction for a spend that
    // cannot be taken back.
    rcRenew.mockResolvedValue({ status: "error", message: "???" });
    const err = await renewDomainCommand(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBe("sent_unknown");
  });

  it("a throw mid-flight is classified, not swallowed", async () => {
    rcRenew.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    const err = await renewDomainCommand(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBe("sent_unknown");
  });
});

describe("the reconciler answers by reading, which is why this needs no human", () => {
  const rctx = { subject: "acme.in", request: { years: 1, expiryBefore: BEFORE } };

  it("expiry moved past the baseline → done", async () => {
    getDomainDetails.mockResolvedValue(found(AFTER));
    expect(await reconcileRenew(rctx)).toBe("done");
  });

  it("expiry unchanged → not_done, and a retry is free", async () => {
    getDomainDetails.mockResolvedValue(found(BEFORE));
    expect(await reconcileRenew(rctx)).toBe("not_done");
  });

  it("expiry EARLIER than the baseline → unknown, never a guess", async () => {
    getDomainDetails.mockResolvedValue(found(BEFORE - 86400));
    expect(await reconcileRenew(rctx)).toBe("unknown");
  });

  it.each([
    { kind: "not_found", reason: "gone" },
    { kind: "hard_failure", reason: "RC 500" },
  ])("an unreadable provider ($kind) → unknown", async (outcome) => {
    getDomainDetails.mockResolvedValue(outcome);
    expect(await reconcileRenew(rctx)).toBe("unknown");
  });

  it("details with no expiry → unknown", async () => {
    getDomainDetails.mockResolvedValue({ kind: "found", details: {} });
    expect(await reconcileRenew(rctx)).toBe("unknown");
  });

  it("a stored request without a baseline → unknown, and asks nothing", async () => {
    // Without expiryBefore there is nothing to compare against, so the honest
    // answer is that we cannot tell.
    expect(await reconcileRenew({ subject: "acme.in", request: { years: 1 } })).toBe("unknown");
    expect(getDomainDetails).not.toHaveBeenCalled();
  });
});
