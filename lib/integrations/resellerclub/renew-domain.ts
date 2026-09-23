/**
 * Typed wrapper around `ResellerClubWrapper.renewDomain`. Maps the
 * raw RC response (including exceptions) onto `RenewDomainOutcome` so
 * callers `switch` instead of inspecting `result.status` /
 * `result.message`.
 *
 * The underlying wrapper does an order-id + expiry pre-flight lookup
 * inside; if either of those returns `{status:"error"}` the wrapper
 * surfaces that as a normal error response. We classify it as
 * `hard_failure` here — callers shouldn't have to distinguish "lookup
 * failed" from "registry rejected" (both are unfixable from the
 * caller's POV).
 *
 * They DO have to distinguish how far the request got, though, which is a
 * different question from whose fault it is. Every `hard_failure` therefore
 * carries a `transport`: a renewal is not known to be idempotent, so "nothing
 * left the machine" and "the socket died after the POST" must not share a
 * shape. The first is free to retry; the second may already have bought a year.
 */
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import type { RenewDomainOutcome } from "./types";
import { classifyTransport } from "../transport";
import {
  classifyRenewDomainResponse,
  matchesAny,
  BALANCE_PENDING_FRAGMENTS,
} from "./classify";

export interface RenewDomainInput {
  domainName: string;
  /** 1-10 (RC's hard cap). */
  years: number;
}

export async function renewDomain(input: RenewDomainInput): Promise<RenewDomainOutcome> {
  try {
    const raw = await ResellerClubWrapper.renewDomain(input.domainName, input.years);
    const outcome = classifyRenewDomainResponse(raw);
    if (outcome.kind === "hard_failure") {
      serverLogger.error(
        `[RC] renewDomain hard_failure for ${input.domainName}: ${outcome.reason}`
      );
      /**
       * ResellerClub ANSWERED, and the answer was a refusal — so the renewal
       * is known NOT to have happened and a retry is free. The classifier sets
       * `transport: "responded"` itself rather than having it re-asserted here,
       * because it is the thing that knows a response was parsed.
       */
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    serverLogger.error(`[RC] renewDomain threw for ${input.domainName}: ${message}`);
    if (matchesAny(message, BALANCE_PENDING_FRAGMENTS)) {
      return { kind: "balance_pending" };
    }
    /**
     * A throw used to collapse to a bare `hard_failure`, which read exactly
     * like the refusal above and sent the caller to a 500 — the status every
     * client retries. On a renewal that is how a year gets bought twice.
     *
     * `sentBefore: true` because by the time anything in here throws, the
     * request has been attempted. `classifyTransport` still returns `not_sent`
     * for ENOTFOUND / ECONNREFUSED / EAI_AGAIN, which prove no connection was
     * established; ECONNRESET and ETIMEDOUT deliberately become `sent_unknown`,
     * because a reset can arrive after the bytes were acted on.
     *
     * Known imprecision, stated rather than hidden: `ResellerClubWrapper`
     * does an order-id and expiry PRE-FLIGHT inside this same call, so a throw
     * from that lookup — before any renewal was attempted — is also classified
     * `sent_unknown` when its error code is ambiguous. That errs toward "a
     * human checks", which is the safe direction for a non-idempotent spend.
     */
    return {
      kind: "hard_failure",
      reason: message,
      transport: classifyTransport(err, true),
    };
  }
}
